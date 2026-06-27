/**
 * WASM emission stage of the compile pipeline (= plan Q-F no-argument `process`
 * plus fixed-region WASM exports; one of the per-stage internal modules of plan
 * Q-D).
 *
 * Dynamically imports binaryen (= `09-repo-structure.md` §2.4 invariant: it is
 * not included in the static-path consumer's production runtime bundle) and
 * lowers AST → binaryen IR. Output = WASM binary (= Uint8Array).
 *
 * The WASM linear memory pre-allocates `layout.totalBytes` rounded up to 64 KB
 * pages, with min == max (= permanently rules out `memory.grow`,
 * `00-foundations.md` §5.1 invariant). Exports = `process` (= no arguments,
 * Q-F) + `memory` (= the host marshals I/O at fixed offsets).
 *
 * forSample = a bounded loop (= ported from the Phase 1 step-1.7 path) that
 * advances by `stride` each iteration, with the loop counter held in local 0.
 * Phase 3 assumes a single forSample level (= canonical Ex 1 minus the meter);
 * nested forSample / forSample.byN support is filled in by a later phase.
 */

import type { AstNode, CapturedGraph } from "./ast.ts";
import type { Layout } from "./layout.ts";
import { formatVerifyViolations, verifyRealtimeSafe } from "./verify.ts";
import type { BufferElementType, ScalarType } from "../types.ts";

export type BinaryenAPI = (typeof import("binaryen"))["default"];
export type BinaryenModule = InstanceType<BinaryenAPI["Module"]>;

const BYTES_PER_F32 = 4;
const BYTES_PER_F64 = 8;
const BYTES_PER_I32 = 4;
const BYTES_PER_I64 = 8;
const CHANNEL_STRIDE_BYTES = 128 * BYTES_PER_F32;
const PAGE_BYTES = 65536;
const LOOP_COUNTER_LOCAL = 0;
/**
 * Subnormal-guard temp locals for f32 / f64 (= function locals array index 1 / 2).
 *
 * When the subnormal guard builds `|v| < 1e-30 ? 0 : v`, v has to be referenced
 * twice: once in the `abs / lt` condition and once in the `select` else branch.
 * Naively calling `emitExpression(valueNode, ...)` twice makes binaryen enter a
 * shared / malformed expression-generation path for v "in the context of an
 * audioInRead after forSample", producing NaN (= measured). The standard path
 * is `local.tee`: evaluate v once, store it in a local, pass the value through,
 * and re-fetch it with `local.get` whenever it is needed again = no duplicate
 * evaluation and no traversal of binaryen's internal sharing path.
 */
const SUBNORMAL_F32_LOCAL = 1;
const SUBNORMAL_F64_LOCAL = 2;
/**
 * i32 temp local for the publish scheduler (= sub-phase 7.3). For each publish
 * slot, the sample counter is evaluated once after += 128, the threshold check
 * runs, and on the due path the counter is re-fetched as counter -= threshold
 * (= avoids duplicate evaluation and sidesteps the binaryen internal-path
 * pitfall, same approach as the subnormal guard).
 */
const PUBLISH_COUNTER_LOCAL = 3;

/**
 * i32 temp locals for `event.emitIf` (= sub-phase 7.6 commit 4).
 *
 * - `EVENT_HEAD_LOCAL` = load the ring head once, then re-fetch it for the
 *   overflow check, the slot-offset computation, and the head += 1 store
 *   (= no duplicate evaluation).
 * - `EVENT_SLOT_PTR_LOCAL` = compute the slot pointer (= base + 12 +
 *   (head % capacity) × slotSize) once and re-fetch it for each field store
 *   (= avoids recomputation and the binaryen-path pitfall).
 */
const EVENT_HEAD_LOCAL = 4;
const EVENT_SLOT_PTR_LOCAL = 5;
/**
 * i32 temp local for the `message.onReceive` drain (= sub-phase 7.7c).
 * - `MESSAGE_TAIL_LOCAL` = load the ring tail once, advance it by += 1 inside
 *   the drain loop, and commit it to the SAB at the end of the drain.
 * EVENT_HEAD_LOCAL / EVENT_SLOT_PTR_LOCAL are shared by the message ring drain
 * (= forSample / event emit and message drain run mutually exclusively within
 *   the same `process` call, so there is no local-lifetime conflict).
 */
const MESSAGE_TAIL_LOCAL = 6;

/**
 * f32 temp local for `frac`. frac(x) = x - floor(x) references x twice =
 * `tee` evaluates it once and holds it in the local, and the floor side
 * re-fetches it with `get`. Because WASM has strict left-to-right evaluation and
 * emit runs no optimizer, as long as the `get(L)` consumes the value right after
 * `tee(L,…)` with no write to L in between, even nesting (= frac(frac(x))) cannot
 * mix the values up (= the inner expression is fully evaluated before the outer
 * tee overwrites L).
 */
const FRAC_F32_LOCAL = 7;

/**
 * Three f32 temp locals for `mod`. mod(a,b) = a - trunc(a/b)·b references a / b /
 * quotient multiple times = each is evaluated once and held in a local. The
 * quotient (= MOD_Q) is referenced twice by the infinite-divisor guard
 * (= avoids `0·Inf=NaN`, see below). Nesting safety: a is pushed onto the stack
 * as the left operand of the outermost `sub` and carried through, while b /
 * quotient are read only after the rhs is evaluated and the quotient is
 * computed, so even if an inner mod overwrites the same locals there is no mix-up.
 */
const MOD_A_F32_LOCAL = 8;
const MOD_B_F32_LOCAL = 9;
const MOD_Q_F32_LOCAL = 10;

/**
 * f64 temp locals (= same roles as the f32 versions, for the f64 path). Used by
 * the frac double-evaluation guard and the JS `%`-conforming special impl of mod.
 */
const FRAC_F64_LOCAL = 11;
const MOD_A_F64_LOCAL = 12;
const MOD_B_F64_LOCAL = 13;
const MOD_Q_F64_LOCAL = 14;

/**
 * Temp locals for `buffer.readInterpolated`. pos is evaluated once and held in
 * an f32 local (= referenced twice, for the floor index and the frac), and the
 * truncated integer index is held in an i32 local (= referenced twice, for the
 * i / i+1 two-tap addresses). Avoids double evaluation.
 */
const BUFINTERP_POS_LOCAL = 15;
const BUFINTERP_I0_LOCAL = 16;

/**
 * i32 temp local for the OOB clamp of `payloadField.at(idx)` (= §4.3). idx is
 * evaluated once and held in the local, then rounded into [0, length-1] by a
 * two-stage select `min(idx, length-1)` → `max(_, 0)` before the content load
 * (= eliminates runtime traps; idx is referenced multiple times).
 */
const PAYLOAD_CLAMP_LOCAL = 17;

/**
 * v128 temp local for SIMD `sumLanes` (= §7). vec is evaluated once and held,
 * then its 4 lanes are pulled out with `extract_lane` (= avoids evaluating the
 * vec expression 4 times).
 */
const VEC_TEMP_LOCAL = 18;

/**
 * Base local index for mutable-read temp locals (= `03-compiler.md` §2.7, issue
 * #8). The 19 fixed temp locals above occupy indices 0–18; per-read temps from
 * `captureTemp` occupy `TEMP_LOCAL_BASE + tempId` (= 19, 20, …). `emit` scans
 * the graph for `tempAssign` nodes and declares one local of the matching type
 * per `tempId`, in `tempId` order, after the fixed block.
 */
const TEMP_LOCAL_BASE = 19;

/**
 * Per-emit loop-counter local mapping for nested `forSample` (= Q58). A loop /
 * `loopCounter` at nesting depth `d` uses local `loopCounterLocal(d)`: depth 0
 * reuses `LOOP_COUNTER_LOCAL` (= byte-identical to the single-loop case), deeper
 * levels get fresh i32 locals appended after the mutable-read temp locals
 * (`nestBase + (d - 1)`). `nestBase` is set per-emit; `maxDepth` (the deepest loop
 * seen) drives how many extra locals the function declares. Reset at the top of
 * `emit()`; emit runs synchronously after the binaryen import, so a concurrent
 * compile cannot interleave. Depth is carried on the AST node (not a runtime
 * stack), so each case is a pure depth → local computation.
 */
const loopEmit = { nestBase: 0, maxDepth: 0 };
const loopCounterLocal = (depth: number): number =>
  depth === 0 ? LOOP_COUNTER_LOCAL : loopEmit.nestBase + (depth - 1);

/**
 * The polynomial-approximation math primitives (= sin / cos / tan / tanh / exp /
 * log, Q17) are emitted as shared private WASM functions (= `(f32) -> f32`, not
 * exported), and the call sites reference them via `call`. Each function has its
 * own locals, so they do not interfere with `process`'s fixed temp locals. Only
 * the kinds actually used in the graph are added (= `collectUsedMathKinds`).
 */
const MATH_FN_PREFIX = "$unworklet_";

/**
 * Subnormal flush threshold (= Q21, `04-worklet-runtime.md` §6).
 * `state.f32` / `state.f64`'s `.store(v)` flushes `|v| < 1e-30` to 0 to
 * eliminate the CPU spike on the IIR feedback path. The threshold 1e-30 is a
 * simple boundary that covers the IEEE 754 binary32 subnormal range
 * (≈ 1.18e-38 and below); the tail of the normal range is flushed too, but it is
 * inaudible as audio output = a single-value fix.
 */
const SUBNORMAL_THRESHOLD = 1e-30;

/**
 * `emit` options (= added in sub-phase 7.3). Const-folds sampleRate, as a
 * build-time constant, into the publish scheduler's threshold =
 * `Math.round(sampleRate / rateFps)`. default = 48000 (= matches the existing
 * fixture / host default).
 */
export type EmitOptions = {
  sampleRate?: number;
};

const DEFAULT_EMIT_SAMPLE_RATE = 48000;

/**
 * Little-endian byte encoding of a `state.<type>(initial)` value, sized to the
 * slot's element width. `bool` is held as i32 (0/1). Used to seed state slots
 * via active data segments at WASM instantiation (= declaration defaults).
 */
function encodeStateInitial(type: ScalarType, value: number | bigint | boolean): Uint8Array {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  switch (type) {
    case "f32":
      dv.setFloat32(0, Number(value), true);
      return new Uint8Array(buf.slice(0, BYTES_PER_F32));
    case "f64":
      dv.setFloat64(0, Number(value), true);
      return new Uint8Array(buf.slice(0, BYTES_PER_F64));
    case "i32":
      dv.setInt32(0, Number(value) | 0, true);
      return new Uint8Array(buf.slice(0, BYTES_PER_I32));
    case "i64":
      dv.setBigInt64(0, BigInt(value as bigint), true);
      return new Uint8Array(buf.slice(0, BYTES_PER_I64));
    case "bool":
      dv.setInt32(0, value ? 1 : 0, true);
      return new Uint8Array(buf.slice(0, BYTES_PER_I32));
  }
}

/**
 * Active data segments that seed every `state.<type>` slot with its declared
 * `initial` value at WASM instantiation (= declaration defaults; restore /
 * migration overwrites later). Zero-valued initials are skipped — linear memory
 * is already zero. Both the online worklet and the offline driver instantiate
 * the same binary, so state init is consistent across runtimes.
 */
function stateInitSegments(
  graph: CapturedGraph,
  layout: Layout,
  mod: BinaryenModule,
): { offset: number; data: Uint8Array }[] {
  const segments: { offset: number; data: Uint8Array }[] = [];
  for (const decl of graph.declarations) {
    if (decl.kind !== "state") continue;
    const isZero = decl.type === "i64" ? decl.initial === 0n : Number(decl.initial) === 0;
    if (isZero) continue;
    const offset = layout.regions.states.slots[decl.name];
    /* v8 ignore next 2 — the state slot is always pushed by layout = unreachable */
    if (offset === undefined) throw new Error(`unknown state slot: ${decl.name}`);
    segments.push({
      offset: mod.i32.const(offset),
      data: encodeStateInitial(decl.type, decl.initial),
    });
  }
  return segments;
}

/** Map a scalar type to its binaryen value type (`bool` is held as i32). */
function binaryenTypeOf(type: ScalarType, binaryen: BinaryenAPI): number {
  switch (type) {
    case "f32":
      return binaryen.f32;
    case "f64":
      return binaryen.f64;
    case "i64":
      return binaryen.i64;
    case "i32":
    case "bool":
      return binaryen.i32;
  }
}

/**
 * Collect the temp-local binaryen types declared by `captureTemp` (= issue #8),
 * indexed by `tempId`. Walks statement containers only — `tempAssign` nodes are
 * always recorded at statement level (the read is captured before its enclosing
 * statement), never nested inside an expression operand, so a shallow walk over
 * the statement-bearing kinds is exhaustive.
 */
function collectTempLocals(graph: CapturedGraph, binaryen: BinaryenAPI): number[] {
  const byId = new Map<number, ScalarType>();
  const walk = (stmts: readonly AstNode[]): void => {
    for (const s of stmts) {
      if (s.kind === "tempAssign") {
        byId.set(s.tempId, s.valueType);
      } else if (
        s.kind === "forSample" ||
        s.kind === "everyNSamples" ||
        s.kind === "messageOnReceive" ||
        s.kind === "midiOnEvent"
      ) {
        walk(s.body);
      }
    }
  };
  walk(graph.statements);
  const maxId = byId.size > 0 ? Math.max(...byId.keys()) : -1;
  const locals: number[] = [];
  for (let id = 0; id <= maxId; id++) {
    locals.push(binaryenTypeOf(byId.get(id) ?? "i32", binaryen));
  }
  return locals;
}

export async function emit(
  graph: CapturedGraph,
  layout: Layout,
  options: EmitOptions = {},
): Promise<Uint8Array> {
  const sampleRate = options.sampleRate ?? DEFAULT_EMIT_SAMPLE_RATE;
  const binaryen = (await import("binaryen")).default;
  const mod = new binaryen.Module();
  // buffer.copyFrom = memory.copy (= bulk-memory, Q31-c), SIMD = f32x4 (= §7).
  // Added on top of the default features (MVP) so that emitBinary can emit the opcodes.
  mod.setFeatures(mod.getFeatures() | binaryen.Features.BulkMemory | binaryen.Features.SIMD128);

  const pages = Math.max(1, Math.ceil(layout.totalBytes / PAGE_BYTES));
  // Active data segments seed `state.<type>` slots with their declared initial
  // values at instantiation (= declaration defaults; restore overwrites later).
  mod.setMemory(pages, pages, "memory", stateInitSegments(graph, layout, mod));

  // Add the polynomial-approximation math primitives (= sin etc., Q17) as shared
  // private functions. Only the kinds used in the graph are emitted.
  addMathFunctions(collectUsedMathKinds(graph), mod, binaryen);

  // Q38-b rule: every onReceive handler drains before the per-block top /
  // forSample. The emit order does not follow source order = the framework
  // reorders by "collect the messageOnReceive nodes and emit them first, then
  // emit the other statements" (= docs `01-dsl.md` §4.2 + §1). Multiple
  // onReceive registrations for the same message are merged into one drain loop,
  // and at each slot all registration bodies fire back-to-back in registration
  // order (= Q38-c).
  // Mutable-read temp locals occupy TEMP_LOCAL_BASE.. ; nested loop-counter
  // locals (if any) are appended after them. Reset the per-emit loop state before
  // building the body (the forSample case fills `maxDepth`).
  const tempLocals = collectTempLocals(graph, binaryen);
  loopEmit.nestBase = TEMP_LOCAL_BASE + tempLocals.length;
  loopEmit.maxDepth = 0;

  const onReceiveByMessage = new Map<string, AstNode[]>();
  // MIDI inbound handlers grouped per port (= Q38-b: drain before per-block /
  // forSample, registration order Q38-c). One drain loop per port dispatches by
  // status byte across all registered event-type handlers.
  const midiHandlersByPort = new Map<string, Array<AstNode & { kind: "midiOnEvent" }>>();
  const otherStmts: AstNode[] = [];
  for (const s of graph.statements) {
    if (s.kind === "messageOnReceive") {
      const merged = onReceiveByMessage.get(s.name) ?? [];
      merged.push(...s.body);
      onReceiveByMessage.set(s.name, merged);
    } else if (s.kind === "midiOnEvent") {
      const list = midiHandlersByPort.get(s.port) ?? [];
      list.push(s);
      midiHandlersByPort.set(s.port, list);
    } else {
      otherStmts.push(s);
    }
  }
  const onReceiveEmits = [...onReceiveByMessage.entries()].map(([name, body]) =>
    emitMessageOnReceive({ kind: "messageOnReceive", name, body }, layout, mod, binaryen),
  );
  const midiDrainEmits = [...midiHandlersByPort.entries()].map(([port, handlers]) =>
    emitMidiInputDrain(port, handlers, layout, mod, binaryen),
  );
  const otherEmits = otherStmts.map((s) => emitStatement(s, layout, mod, binaryen));
  const schedulerBlocks = emitPublishScheduler(graph, layout, sampleRate, mod, binaryen);
  const body = mod.block(null, [
    ...onReceiveEmits,
    ...midiDrainEmits,
    ...otherEmits,
    ...schedulerBlocks,
  ]);

  // function locals = [i32 loop counter, f32 subnormal guard temp, f64 subnormal guard temp,
  //                    i32 publish counter temp, i32 event head temp, i32 event/message slot ptr temp,
  //                    i32 message tail temp].
  // Event emit evaluates head / slot ptr once and re-fetches them for each field
  // store; the message drain loads tail once, advances it in the drain loop, and
  // commits it.
  mod.addFunction(
    "process",
    binaryen.none,
    binaryen.none,
    [
      binaryen.i32,
      binaryen.f32,
      binaryen.f64,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.f32, // FRAC_F32_LOCAL (= frac temp)
      binaryen.f32, // MOD_A_F32_LOCAL (= mod dividend temp)
      binaryen.f32, // MOD_B_F32_LOCAL (= mod divisor temp)
      binaryen.f32, // MOD_Q_F32_LOCAL (= mod quotient temp)
      binaryen.f64, // FRAC_F64_LOCAL
      binaryen.f64, // MOD_A_F64_LOCAL
      binaryen.f64, // MOD_B_F64_LOCAL
      binaryen.f64, // MOD_Q_F64_LOCAL
      binaryen.f32, // BUFINTERP_POS_LOCAL
      binaryen.i32, // BUFINTERP_I0_LOCAL
      binaryen.i32, // PAYLOAD_CLAMP_LOCAL (= at OOB clamp idx)
      binaryen.v128, // VEC_TEMP_LOCAL (= for SIMD sumLanes)
      // Mutable-read temp locals (= TEMP_LOCAL_BASE +, issue #8, in capture order).
      ...tempLocals,
      // Extra i32 loop-counter locals for nested forSample (= depth >= 1, Q58).
      // Empty when no forSample nests, so the single-loop case stays byte-identical.
      ...Array.from({ length: Math.max(0, loopEmit.maxDepth - 1) }, () => binaryen.i32),
    ],
    body,
  );
  mod.addFunctionExport("process", "process");

  // Layer A: prove the emitted audio path is realtime-safe by construction
  // (allocation-free, no unbounded loop, no deliberate trap) before it can ever
  // become bytes. A violation fails compile() rather than shipping a binary that
  // could glitch or latch silence on the audio thread.
  const violations = verifyRealtimeSafe(mod, binaryen);
  if (violations.length > 0) {
    mod.dispose();
    throw new Error(formatVerifyViolations(violations));
  }

  const wasm = mod.emitBinary();
  mod.dispose();
  return wasm;
}

/**
 * publish scheduler emit (= sub-phase 7.3, `04-worklet-runtime.md` §7).
 *
 * For each state slot carrying a publish flag, inlined at the end of the process
 * function:
 * 1. local PUBLISH_COUNTER_LOCAL = `i32.load(counterOffset) + SAMPLES_PER_BLOCK`
 * 2. if local >= threshold:
 *    - copy the state value into publishShared (= per-type load + store)
 *    - i32.store(versionOffset, i32.load(versionOffset) + 1)
 *    - i32.store(counterOffset, local - threshold)  (= carry the remainder)
 *    else:
 *    - i32.store(counterOffset, local)
 *
 * threshold = `Math.round(sampleRate / rateFps)` = build-time const fold.
 */
function emitPublishScheduler(
  graph: CapturedGraph,
  layout: Layout,
  sampleRate: number,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number[] {
  const blocks: number[] = [];
  for (const decl of graph.declarations) {
    if (decl.kind !== "state" || decl.publish === undefined) continue;
    const stateOffset = layout.regions.states.slots[decl.name];
    const sharedOffset = layout.regions.publishShared.slots[decl.name];
    const counterOffset = layout.regions.publishCounters.slots[decl.name];
    /* v8 ignore next 3 — a state slot with publish is already pushed by layout =
       unreachable defensive guard */
    if (stateOffset === undefined || sharedOffset === undefined || counterOffset === undefined) {
      throw new Error(`unknown publish slot: ${decl.name}`);
    }
    const versionOffset = counterOffset + 4;
    const threshold = Math.round(sampleRate / decl.publish.rateFps);

    // per-type load / store (= types carrying a publish flag are restricted to f32 / i32 / bool by Q42)
    const loadValue =
      decl.type === "f32"
        ? mod.f32.load(0, BYTES_PER_F32, mod.i32.const(stateOffset))
        : mod.i32.load(0, BYTES_PER_I32, mod.i32.const(stateOffset));
    const storeValueFn =
      decl.type === "f32"
        ? (value: number) => mod.f32.store(0, BYTES_PER_F32, mod.i32.const(sharedOffset), value)
        : (value: number) => mod.i32.store(0, BYTES_PER_I32, mod.i32.const(sharedOffset), value);

    blocks.push(
      mod.block(null, [
        // local PUBLISH_COUNTER_LOCAL = i32.load(counterOffset) + SAMPLES_PER_BLOCK
        mod.local.set(
          PUBLISH_COUNTER_LOCAL,
          mod.i32.add(
            mod.i32.load(0, BYTES_PER_I32, mod.i32.const(counterOffset)),
            mod.i32.const(128),
          ),
        ),
        mod.if(
          mod.i32.ge_s(
            mod.local.get(PUBLISH_COUNTER_LOCAL, binaryen.i32),
            mod.i32.const(threshold),
          ),
          // due path: copy + version increment + counter -= threshold
          mod.block(null, [
            storeValueFn(loadValue),
            mod.i32.store(
              0,
              BYTES_PER_I32,
              mod.i32.const(versionOffset),
              mod.i32.add(
                mod.i32.load(0, BYTES_PER_I32, mod.i32.const(versionOffset)),
                mod.i32.const(1),
              ),
            ),
            mod.i32.store(
              0,
              BYTES_PER_I32,
              mod.i32.const(counterOffset),
              mod.i32.sub(
                mod.local.get(PUBLISH_COUNTER_LOCAL, binaryen.i32),
                mod.i32.const(threshold),
              ),
            ),
          ]),
          // not due path: just save the new counter
          mod.i32.store(
            0,
            BYTES_PER_I32,
            mod.i32.const(counterOffset),
            mod.local.get(PUBLISH_COUNTER_LOCAL, binaryen.i32),
          ),
        ),
      ]),
    );
  }
  return blocks;
}

/** The binaryen float namespace for a scalar type (`f64` or `f32`). */
function floatNs(mod: BinaryenModule, type: ScalarType) {
  return type === "f64" ? mod.f64 : mod.f32;
}

/**
 * Type-dispatched `max` / `min`. WASM has native `f{32,64}.{max,min}` but **no**
 * integer max/min instruction, so `i32` / `i64` lower to `select(a {>|<} b, a, b)`
 * via a signed compare. The operand thunks are evaluated twice (once in the
 * compare, once in the selected branch); operands are pure side-effect-free
 * expressions with no intervening store, so both evaluations are identical.
 */
function emitMaxMin(
  mod: BinaryenModule,
  type: ScalarType,
  op: "max" | "min",
  emitA: () => number,
  emitB: () => number,
): number {
  if (type === "i32") {
    const cond = op === "max" ? mod.i32.gt_s(emitA(), emitB()) : mod.i32.lt_s(emitA(), emitB());
    return mod.select(cond, emitA(), emitB());
  }
  if (type === "i64") {
    const cond = op === "max" ? mod.i64.gt_s(emitA(), emitB()) : mod.i64.lt_s(emitA(), emitB());
    return mod.select(cond, emitA(), emitB());
  }
  return op === "max"
    ? floatNs(mod, type).max(emitA(), emitB())
    : floatNs(mod, type).min(emitA(), emitB());
}

/**
 * Type-dispatched `abs`. WASM has `f{32,64}.abs` but no integer abs, so `i32` /
 * `i64` lower to `select(x < 0, -x, x)` (= signed compare + negate). The operand
 * thunk is evaluated multiple times (pure side-effect-free expression → identical).
 */
function emitAbs(mod: BinaryenModule, type: ScalarType, emitX: () => number): number {
  if (type === "i32") {
    return mod.select(
      mod.i32.lt_s(emitX(), mod.i32.const(0)),
      emitNeg(mod, type, emitX()),
      emitX(),
    );
  }
  if (type === "i64") {
    return mod.select(
      mod.i64.lt_s(emitX(), i64Const(mod, 0n)),
      emitNeg(mod, type, emitX()),
      emitX(),
    );
  }
  return floatNs(mod, type).abs(emitX());
}

/**
 * Type-dispatched numeric binary op (= polymorphic arithmetic / comparison
 * lowering). `op` is the binaryen instruction name (= comparisons use `le` /
 * `ge`; the caller maps the AST kinds `lte` / `gte`). Integers are signed
 * (= `div_s` / `lt_s` etc.). The i64 dispatch was added in the i64 stage.
 */
function emitNumericBinary(
  mod: BinaryenModule,
  type: ScalarType,
  op: "add" | "sub" | "mul" | "div" | "eq" | "lt" | "gt" | "le" | "ge",
  lhs: number,
  rhs: number,
): number {
  if (type === "i32") {
    switch (op) {
      case "add":
        return mod.i32.add(lhs, rhs);
      case "sub":
        return mod.i32.sub(lhs, rhs);
      case "mul":
        return mod.i32.mul(lhs, rhs);
      case "div":
        return mod.i32.div_s(lhs, rhs);
      case "eq":
        return mod.i32.eq(lhs, rhs);
      case "lt":
        return mod.i32.lt_s(lhs, rhs);
      case "gt":
        return mod.i32.gt_s(lhs, rhs);
      case "le":
        return mod.i32.le_s(lhs, rhs);
      case "ge":
        return mod.i32.ge_s(lhs, rhs);
    }
  }
  // i64 = signed (= div_s / lt_s etc.). Comparisons return i32 (= bool 0/1).
  if (type === "i64") {
    switch (op) {
      case "add":
        return mod.i64.add(lhs, rhs);
      case "sub":
        return mod.i64.sub(lhs, rhs);
      case "mul":
        return mod.i64.mul(lhs, rhs);
      case "div":
        return mod.i64.div_s(lhs, rhs);
      case "eq":
        return mod.i64.eq(lhs, rhs);
      case "lt":
        return mod.i64.lt_s(lhs, rhs);
      case "gt":
        return mod.i64.gt_s(lhs, rhs);
      case "le":
        return mod.i64.le_s(lhs, rhs);
      case "ge":
        return mod.i64.ge_s(lhs, rhs);
    }
  }
  // f32 / f64.
  const fl = floatNs(mod, type);
  switch (op) {
    case "add":
      return fl.add(lhs, rhs);
    case "sub":
      return fl.sub(lhs, rhs);
    case "mul":
      return fl.mul(lhs, rhs);
    case "div":
      return fl.div(lhs, rhs);
    case "eq":
      return fl.eq(lhs, rhs);
    case "lt":
      return fl.lt(lhs, rhs);
    case "gt":
      return fl.gt(lhs, rhs);
    case "le":
      return fl.le(lhs, rhs);
    case "ge":
      return fl.ge(lhs, rhs);
  }
}

/**
 * `i64.const` from a bigint. binaryen 129's `i64.const` takes a single bigint
 * argument, but the bundled d.ts still has the old `(low, high)` signature
 * (= mismatched with the implementation). Inline-call the member expression and
 * cast = pass the types while preserving the `this` binding.
 */
function i64Const(mod: BinaryenModule, value: bigint): number {
  return (mod.i64.const as unknown as (value: bigint) => number)(value);
}

/** Type-dispatched negation. WASM has no integer `neg` = `0 - x`. */
function emitNeg(mod: BinaryenModule, type: ScalarType, x: number): number {
  if (type === "i32") return mod.i32.sub(mod.i32.const(0), x);
  if (type === "i64") return mod.i64.sub(i64Const(mod, 0n), x);
  return floatNs(mod, type).neg(x);
}

/**
 * Transcendental call (= sin / cos / tan / tanh / exp / log). The shared function
 * is `(f32) -> f32` (= Q17 polynomial approximation; the body is added by
 * `addMathFunctions`). An f64 operand goes through the f32 bridge:
 * `promote(call(demote(value)))`. Rather than duplicating the shared function per
 * type, the precision is normalized to f32-equivalent (~1e-4) (= the
 * type-agnostic approximate-math contract). `value` is an already-emitted
 * expression (= matching node.type).
 */
function emitTranscendental(
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
  kind: "sin" | "cos" | "tan" | "tanh" | "exp" | "log",
  type: ScalarType,
  value: number,
): number {
  if (type === "f64") {
    return mod.f64.promote(
      mod.call(`${MATH_FN_PREFIX}${kind}`, [mod.f32.demote(value)], binaryen.f32),
    );
  }
  return mod.call(`${MATH_FN_PREFIX}${kind}`, [value], binaryen.f32);
}

/**
 * Cross-precision convert lowering (= scalar constructors `f32(node)` etc.,
 * no-trap: integer truncation is saturating). Implements i32 ↔ f32 / i32 ↔ f64 /
 * f32 ↔ f64, i64 narrowing, and bool ↔ numeric. Widening to i64 (= i32/f32/.. →
 * i64) has no convert by the bigint-only construction convention (= use
 * `i64(BigInt(...))`).
 */
function emitConvert(mod: BinaryenModule, from: ScalarType, to: ScalarType, value: number): number {
  if (from === "i32" && to === "f32") return mod.f32.convert_s.i32(value);
  if (from === "f32" && to === "i32") return mod.i32.trunc_s_sat.f32(value);
  if (from === "i32" && to === "f64") return mod.f64.convert_s.i32(value);
  if (from === "f64" && to === "i32") return mod.i32.trunc_s_sat.f64(value);
  if (from === "f32" && to === "f64") return mod.f64.promote(value);
  if (from === "f64" && to === "f32") return mod.f32.demote(value);
  // i64 is bigint-only construction (= no widening convert), narrowing only: to
  // i32 is wrap (= the low 32 bits), and to f32 / f64 is a signed convert.
  if (from === "i64" && to === "i32") return mod.i32.wrap(value);
  if (from === "i64" && to === "f32") return mod.f32.convert_s.i64(value);
  if (from === "i64" && to === "f64") return mod.f64.convert_s.i64(value);
  // bool is internally i32 (= 0/1). To bool = `x != 0`; from bool = i32
  // (identity) / float (= signed convert to 0.0/1.0; 0/1 is the same value
  // signed or unsigned).
  if (to === "bool") {
    if (from === "i32") return mod.i32.ne(value, mod.i32.const(0));
    if (from === "i64") return mod.i64.ne(value, i64Const(mod, 0n));
    if (from === "f32") return mod.f32.ne(value, mod.f32.const(0));
    if (from === "f64") return mod.f64.ne(value, mod.f64.const(0));
  }
  if (from === "bool") {
    if (to === "i32") return value; // already i32 0/1
    if (to === "f32") return mod.f32.convert_s.i32(value);
    if (to === "f64") return mod.f64.convert_s.i32(value);
  }
  /* v8 ignore next 2 — the remaining pairs are only widening to i64 (= no convert by convention) = unreachable */
  throw new Error(`unworklet: convert ${from} → ${to} not implemented yet`);
}

// ─────────────────────────────────────────────────────────────────────────
// buffer scalar access (= `01-dsl.md` §3.2). element ptr = base + index ×
// sizeof. u8 is a 1-byte load8_u / store8 (= the low 8 bits); bool is an i32 word.
// ─────────────────────────────────────────────────────────────────────────

const BUFFER_ELEMENT_BYTES_EMIT: Record<BufferElementType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
  u8: 1,
};

/** element pointer = bufferBase + index × sizeof(elementType). */
function bufferElementPtr(
  mod: BinaryenModule,
  base: number,
  elementType: BufferElementType,
  indexExpr: number,
): number {
  return mod.i32.add(
    mod.i32.const(base),
    mod.i32.mul(indexExpr, mod.i32.const(BUFFER_ELEMENT_BYTES_EMIT[elementType])),
  );
}

function emitBufferLoad(mod: BinaryenModule, elementType: BufferElementType, ptr: number): number {
  switch (elementType) {
    case "f32":
      return mod.f32.load(0, BYTES_PER_F32, ptr);
    case "f64":
      return mod.f64.load(0, BYTES_PER_F64, ptr);
    case "i32":
    case "bool":
      return mod.i32.load(0, BYTES_PER_I32, ptr);
    case "i64":
      return mod.i64.load(0, BYTES_PER_I64, ptr);
    case "u8":
      // u8 = zero-extended low 8 bits → Node<'i32'>.
      return mod.i32.load8_u(0, 1, ptr);
  }
}

function emitBufferStore(
  mod: BinaryenModule,
  elementType: BufferElementType,
  ptr: number,
  value: number,
): number {
  switch (elementType) {
    case "f32":
      return mod.f32.store(0, BYTES_PER_F32, ptr, value);
    case "f64":
      return mod.f64.store(0, BYTES_PER_F64, ptr, value);
    case "i32":
    case "bool":
      return mod.i32.store(0, BYTES_PER_I32, ptr, value);
    case "i64":
      return mod.i64.store(0, BYTES_PER_I64, ptr, value);
    case "u8":
      // store only the low 8 bits (= i32.store8).
      return mod.i32.store8(0, 1, ptr, value);
  }
}

/** Convert a loaded buffer element to f32 (= for f32-domain interpolation). */
function bufferElementToF32(
  mod: BinaryenModule,
  elementType: BufferElementType,
  loaded: number,
): number {
  switch (elementType) {
    case "f32":
      return loaded;
    case "f64":
      return mod.f32.demote(loaded);
    case "i32":
    case "bool":
    case "u8":
      return mod.f32.convert_s.i32(loaded);
    case "i64":
      return mod.f32.convert_s.i64(loaded);
  }
}

/** Convert an interpolated f32 back to the element's surfaced scalar type. */
function f32ToBufferElement(
  mod: BinaryenModule,
  elementType: BufferElementType,
  value: number,
): number {
  switch (elementType) {
    case "f32":
      return value;
    case "f64":
      return mod.f64.promote(value);
    case "i32":
    case "bool":
    case "u8":
      return mod.i32.trunc_s_sat.f32(value);
    case "i64":
      return mod.i64.trunc_s_sat.f32(value);
  }
}

/**
 * `buffer.readInterpolated(pos)` = linear interpolation (= 2-tap). pos is held in
 * an f32 local, and i0 = trunc(pos) is held in an i32 local (= avoids double
 * evaluation). frac = pos - i0, a = buf[i0], b = buf[i0+1], result =
 * a + (b - a)·frac. The interpolation is done in the f32 domain (= convert the
 * element to f32, compute, then convert back to the element's scalar type). f64
 * buffers are also done in the f32 domain (= no audible difference for wavetable
 * use, same approach as Q17).
 */
function emitBufferReadInterpolated(
  node: AstNode & { kind: "bufferReadInterpolated" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const base = layout.regions.buffers.slots[node.name];
  if (base === undefined) {
    throw new Error(`unknown buffer: ${node.name}`);
  }
  const et = node.elementType;
  const f = binaryen.f32;
  const i = binaryen.i32;
  const i0 = (): number => mod.local.get(BUFINTERP_I0_LOCAL, i);
  const aF32 = bufferElementToF32(
    mod,
    et,
    emitBufferLoad(mod, et, bufferElementPtr(mod, base, et, i0())),
  );
  const bF32 = bufferElementToF32(
    mod,
    et,
    emitBufferLoad(mod, et, bufferElementPtr(mod, base, et, mod.i32.add(i0(), mod.i32.const(1)))),
  );
  // frac = pos - f32(i0)
  const frac = mod.f32.sub(mod.local.get(BUFINTERP_POS_LOCAL, f), mod.f32.convert_s.i32(i0()));
  // result = a + (b - a)·frac  (f32 domain)
  const interp = mod.f32.add(aF32, mod.f32.mul(mod.f32.sub(bF32, aF32), frac));
  const resultScalar = et === "u8" ? "i32" : et;
  const resultTy =
    resultScalar === "f64"
      ? binaryen.f64
      : resultScalar === "f32"
        ? binaryen.f32
        : resultScalar === "i64"
          ? binaryen.i64
          : binaryen.i32;
  return mod.block(
    null,
    [
      mod.local.set(BUFINTERP_POS_LOCAL, emitExpression(node.pos, layout, mod, binaryen)),
      mod.local.set(
        BUFINTERP_I0_LOCAL,
        mod.i32.trunc_s_sat.f32(mod.local.get(BUFINTERP_POS_LOCAL, f)),
      ),
      f32ToBufferElement(mod, et, interp),
    ],
    resultTy,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// typed-array payload reads (= `01-dsl.md` §4.3, message onReceive handler).
// The slot's [payloadLen, payloadOffset] (= via EVENT_SLOT_PTR_LOCAL) plus the
// per-message payloadContent region base give index-read access to the
// variable-length content / its element count.
// ─────────────────────────────────────────────────────────────────────────

function payloadSlotMeta(
  node: AstNode & { kind: "payloadFieldRead" | "payloadFieldLength" },
  layout: Layout,
): { offsetInSlot: number; contentBase: number; elemBytes: number } {
  const slot = layout.regions.messageRings.slots[node.messageName];
  /* v8 ignore next 3 — payloadFieldRead/Length references a declared message via the proxy = unreachable guard */
  if (slot === undefined) {
    throw new Error(`unknown message: ${node.messageName}`);
  }
  const field = slot.fields.find((f) => f.name === node.field);
  /* v8 ignore next 3 — the field is already pushed to decl.fields via the proxy = unreachable guard */
  if (field === undefined) {
    throw new Error(`unknown message payload field: ${node.messageName}.${node.field}`);
  }
  const content = layout.regions.payloadContent.messageSlots[node.messageName];
  /* v8 ignore next 3 — a message with a typed-array field already has its slot pushed in payloadContent */
  if (content === undefined) {
    throw new Error(`unknown payloadContent for message: ${node.messageName}`);
  }
  return {
    offsetInSlot: field.offsetInSlot,
    contentBase: content.base,
    elemBytes: BUFFER_ELEMENT_BYTES_EMIT[node.elementType],
  };
}

function emitPayloadFieldLength(
  node: AstNode & { kind: "payloadFieldLength" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const { offsetInSlot, elemBytes } = payloadSlotMeta(node, layout);
  // Load payloadLen (= bytes) from the slot; element count = payloadLen / sizeof.
  const payloadLen = mod.i32.load(
    0,
    BYTES_PER_I32,
    mod.i32.add(mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32), mod.i32.const(offsetInSlot)),
  );
  return mod.i32.div_s(payloadLen, mod.i32.const(elemBytes));
}

function emitPayloadFieldRead(
  node: AstNode & { kind: "payloadFieldRead" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const { offsetInSlot, contentBase, elemBytes } = payloadSlotMeta(node, layout);
  const slotPtr = (): number => mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32);
  // length = payloadLen (bytes) / sizeof. OOB-clamp upper bound = length - 1.
  const upper = (): number =>
    mod.i32.sub(
      mod.i32.div_s(
        mod.i32.load(0, BYTES_PER_I32, mod.i32.add(slotPtr(), mod.i32.const(offsetInSlot))),
        mod.i32.const(elemBytes),
      ),
      mod.i32.const(1),
    );
  const clamp = (): number => mod.local.get(PAYLOAD_CLAMP_LOCAL, binaryen.i32);
  // Load payloadOffset (= byte offset within contentBase) from the slot's offsetInSlot+4.
  const payloadOffset = mod.i32.load(
    0,
    BYTES_PER_I32,
    mod.i32.add(slotPtr(), mod.i32.const(offsetInSlot + 4)),
  );
  // addr = contentBase + payloadOffset + clampedIdx × sizeof (= clampedIdx is the
  // value already rounded into [0, length-1] within the block, read via local.get).
  const addr = mod.i32.add(
    mod.i32.add(mod.i32.const(contentBase), payloadOffset),
    mod.i32.mul(clamp(), mod.i32.const(elemBytes)),
  );
  const blockType =
    node.elementType === "f32"
      ? binaryen.f32
      : node.elementType === "f64"
        ? binaryen.f64
        : node.elementType === "i64"
          ? binaryen.i64
          : binaryen.i32; // i32 / bool / u8
  // length = payloadLen / sizeof (= element count). Used to detect an empty payload (length 0).
  const lengthExpr = (): number =>
    mod.i32.div_s(
      mod.i32.load(0, BYTES_PER_I32, mod.i32.add(slotPtr(), mod.i32.const(offsetInSlot))),
      mod.i32.const(elemBytes),
    );
  // The 0 returned when length === 0 (= the zero for each elementType).
  const zeroConst =
    node.elementType === "f32"
      ? mod.f32.const(0)
      : node.elementType === "f64"
        ? mod.f64.const(0)
        : node.elementType === "i64"
          ? i64Const(mod, 0n)
          : mod.i32.const(0); // i32 / bool / u8
  // §4.3 select carrier-clamp: evaluate idx once → round into [0, length-1] with
  // a two-stage select → content load. Even on OOB (idx ≥ length or < 0), addr
  // stays within the payload and does not trap. However, when length === 0
  // (= empty payload), upper = -1 collapses the clamp to idx 0, which would leak
  // stale content bytes from a chunk that has no bytes written (= leftover from
  // the payload that last used that chunk). Reject length === 0 with a select and
  // return 0.
  return mod.block(
    null,
    [
      mod.local.set(PAYLOAD_CLAMP_LOCAL, emitExpression(node.index, layout, mod, binaryen)),
      // clamp = min(clamp, length - 1)
      mod.local.set(
        PAYLOAD_CLAMP_LOCAL,
        mod.select(mod.i32.gt_s(clamp(), upper()), upper(), clamp()),
      ),
      // clamp = max(clamp, 0)
      mod.local.set(
        PAYLOAD_CLAMP_LOCAL,
        mod.select(mod.i32.lt_s(clamp(), mod.i32.const(0)), mod.i32.const(0), clamp()),
      ),
      // length === 0 → 0, otherwise the clamped content load (= prevents stale leak from an empty payload).
      mod.select(mod.i32.eqz(lengthExpr()), zeroConst, emitBufferLoad(mod, node.elementType, addr)),
    ],
    blockType,
  );
}

// buf.copyFrom(payloadField) = bulk `memory.copy` from the content region into
// the buffer (= Q31-c). copyBytes = min(payloadLen, bufferSize × sizeof)
// (= min(buf.size, src.length) expressed in bytes).
function emitBufferCopyFrom(
  node: AstNode & { kind: "bufferCopyFrom" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const base = layout.regions.buffers.slots[node.bufferName];
  /* v8 ignore next 3 — the buffer is declared = its slot is already pushed in layout, unreachable guard */
  if (base === undefined) {
    throw new Error(`unknown buffer: ${node.bufferName}`);
  }
  const slot = layout.regions.messageRings.slots[node.messageName];
  const field = slot?.fields.find((f) => f.name === node.field);
  const content = layout.regions.payloadContent.messageSlots[node.messageName];
  /* v8 ignore next 3 — a message with a typed-array field already has its slot + payloadContent pushed */
  if (slot === undefined || field === undefined || content === undefined) {
    throw new Error(`unknown message payload field: ${node.messageName}.${node.field}`);
  }
  const elemBytes = BUFFER_ELEMENT_BYTES_EMIT[node.elementType];
  // Load payloadLen (= bytes) / payloadOffset from the slot (= a fresh node per evaluation).
  const slotPtr = (): number => mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32);
  const payloadLen = (): number =>
    mod.i32.load(0, BYTES_PER_I32, mod.i32.add(slotPtr(), mod.i32.const(field.offsetInSlot)));
  const payloadOffset = mod.i32.load(
    0,
    BYTES_PER_I32,
    mod.i32.add(slotPtr(), mod.i32.const(field.offsetInSlot + 4)),
  );
  const destCapBytes = (): number => mod.i32.const(node.bufferSize * elemBytes);
  // copyBytes = min(payloadLen, destCapBytes) = select(len < cap, len, cap).
  const copyBytes = mod.select(
    mod.i32.lt_u(payloadLen(), destCapBytes()),
    payloadLen(),
    destCapBytes(),
  );
  const destAddr = mod.i32.const(base);
  const srcAddr = mod.i32.add(mod.i32.const(content.base), payloadOffset);
  return mod.memory.copy(destAddr, srcAddr, copyBytes);
}

// SIMD f32x4 vec-producing node → v128 expr (= §7). vec4 = splat lane0 +
// replace_lane 1/2/3, splat = broadcast, binary = f32x4.add/sub/mul/div. Scalar
// lane arguments go through emitExpression (= f32 path); vec operands recurse
// through emitVec.
function emitVec(
  node: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const scalar = (n: AstNode): number => emitExpression(n, layout, mod, binaryen);
  const vec = (n: AstNode): number => emitVec(n, layout, mod, binaryen);
  switch (node.kind) {
    case "vecSplat":
      return mod.f32x4.splat(scalar(node.value));
    case "vecConst": {
      let v = mod.f32x4.splat(scalar(node.lanes[0]));
      v = mod.f32x4.replace_lane(v, 1, scalar(node.lanes[1]));
      v = mod.f32x4.replace_lane(v, 2, scalar(node.lanes[2]));
      v = mod.f32x4.replace_lane(v, 3, scalar(node.lanes[3]));
      return v;
    }
    case "vecAdd":
      return mod.f32x4.add(vec(node.lhs), vec(node.rhs));
    case "vecSub":
      return mod.f32x4.sub(vec(node.lhs), vec(node.rhs));
    case "vecMul":
      return mod.f32x4.mul(vec(node.lhs), vec(node.rhs));
    case "vecDiv":
      return mod.f32x4.div(vec(node.lhs), vec(node.rhs));
    case "bufferLoadVec": {
      const base = layout.regions.buffers.slots[node.name];
      /* v8 ignore next 3 — the buffer is declared = its slot is already pushed in layout = unreachable */
      if (base === undefined) {
        throw new Error(`unknown buffer: ${node.name}`);
      }
      // addr = bufferBase + offset × 4 (f32 element). v128.load = 4 lanes (16 bytes).
      const addr = mod.i32.add(
        mod.i32.const(base),
        mod.i32.mul(scalar(node.offset), mod.i32.const(BYTES_PER_F32)),
      );
      return mod.v128.load(0, BYTES_PER_F32, addr);
    }
    /* v8 ignore next 2 — a scalar node in vec position is ruled out by types = unreachable */
    default:
      throw new Error(`unworklet: expected f32x4 node in vec position, got '${node.kind}'`);
  }
}

export function emitExpression(
  node: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  switch (node.kind) {
    case "literal": {
      // An i64 literal is a bigint (= Q33-c).
      if (node.type === "i64") {
        return i64Const(mod, BigInt(node.value));
      }
      // bool has the internal i32 representation (= 0/1), so it lowers to
      // i32.const (= boolean branch literals of select, etc.). Everything else is
      // a JS number.
      const value = Number(node.value);
      switch (node.type) {
        case "f32":
          return mod.f32.const(value);
        case "f64":
          return mod.f64.const(value);
        case "i32":
        case "bool":
          return mod.i32.const(value);
      }
    }
    case "loopCounter":
      // Read this level's own counter local, so an outer `i` read inside an inner
      // loop body (= a lower depth) still reads the outer counter.
      return mod.local.get(loopCounterLocal(node.depth ?? 0), binaryen.i32);
    case "mul":
    case "add":
    case "sub":
    case "div":
      return emitNumericBinary(
        mod,
        node.type,
        node.kind,
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    // mod(a, b) = a - trunc(a/b)·b (= JS `%`-conforming: truncating, sign follows
    // the dividend). Hold a in MOD_A, b in MOD_B, quotient=trunc(a/b) in MOD_Q.
    //   - b=0 → a/0=Inf → trunc=Inf → Inf·0=NaN → a-NaN=NaN (= JS x%0=NaN).
    //   - For an infinite divisor (|b|=Inf, a finite), quotient=trunc(a/Inf)=0,
    //     so the naive product=0·Inf=NaN, but JS gives 5%Infinity===5 = returns
    //     the dividend. When quotient==0 (⟺ |a|<|b| = the remainder is a itself),
    //     fix this by pinning product to 0 (= so an Inf produced by div-by-zero
    //     etc. flowing into the divisor does not corrupt a finite dividend,
    //     reported by @codex on #6). Inf%5 / Inf%Inf keep quotient≠0 and so
    //     preserve NaN.
    // Nesting safety: a is pushed onto the stack as the left operand of the
    // outermost `sub` and carried through, while b / quotient are read only after
    // the rhs is evaluated and the quotient is computed = no mix-up with an inner
    // mod overwriting the locals. The select sees MOD_Q / MOD_B already fixed by
    // the immediately preceding set.
    case "mod": {
      // Integer remainder = signed `rem_s` (= WASM standard, sign follows the
      // dividend). float (f32 / f64) uses the JS `%`-conforming special impl below.
      if (node.type === "i32") {
        return mod.i32.rem_s(
          emitExpression(node.lhs, layout, mod, binaryen),
          emitExpression(node.rhs, layout, mod, binaryen),
        );
      }
      if (node.type === "i64") {
        return mod.i64.rem_s(
          emitExpression(node.lhs, layout, mod, binaryen),
          emitExpression(node.rhs, layout, mod, binaryen),
        );
      }
      // f64: the same JS `%`-conforming special impl as the f32 version, using f64 locals.
      if (node.type === "f64") {
        const aTeedF64 = mod.local.tee(
          MOD_A_F64_LOCAL,
          emitExpression(node.lhs, layout, mod, binaryen),
          binaryen.f64,
        );
        const setQuotientF64 = mod.local.set(
          MOD_Q_F64_LOCAL,
          mod.f64.trunc(
            mod.f64.div(
              mod.local.get(MOD_A_F64_LOCAL, binaryen.f64),
              mod.local.tee(
                MOD_B_F64_LOCAL,
                emitExpression(node.rhs, layout, mod, binaryen),
                binaryen.f64,
              ),
            ),
          ),
        );
        const productF64 = mod.select(
          mod.f64.eq(mod.local.get(MOD_Q_F64_LOCAL, binaryen.f64), mod.f64.const(0)),
          mod.f64.const(0),
          mod.f64.mul(
            mod.local.get(MOD_Q_F64_LOCAL, binaryen.f64),
            mod.local.get(MOD_B_F64_LOCAL, binaryen.f64),
          ),
        );
        return mod.f64.sub(aTeedF64, mod.block(null, [setQuotientF64, productF64], binaryen.f64));
      }
      const aTeed = mod.local.tee(
        MOD_A_F32_LOCAL,
        emitExpression(node.lhs, layout, mod, binaryen),
        binaryen.f32,
      );
      // get(MOD_A) is read before the rhs is evaluated = a (before any inner mod
      // overwrites it). b is tee'd at the same time.
      const setQuotient = mod.local.set(
        MOD_Q_F32_LOCAL,
        mod.f32.trunc(
          mod.f32.div(
            mod.local.get(MOD_A_F32_LOCAL, binaryen.f32),
            mod.local.tee(
              MOD_B_F32_LOCAL,
              emitExpression(node.rhs, layout, mod, binaryen),
              binaryen.f32,
            ),
          ),
        ),
      );
      const product = mod.select(
        mod.f32.eq(mod.local.get(MOD_Q_F32_LOCAL, binaryen.f32), mod.f32.const(0)),
        mod.f32.const(0),
        mod.f32.mul(
          mod.local.get(MOD_Q_F32_LOCAL, binaryen.f32),
          mod.local.get(MOD_B_F32_LOCAL, binaryen.f32),
        ),
      );
      return mod.f32.sub(aTeed, mod.block(null, [setQuotient, product], binaryen.f32));
    }
    case "abs":
      return emitAbs(mod, node.type, () => emitExpression(node.value, layout, mod, binaryen));
    case "neg":
      return emitNeg(mod, node.type, emitExpression(node.value, layout, mod, binaryen));
    case "not":
      // bool is internally i32 0/1; logical negation is a single `i32.eqz`
      // (= "equals zero": 1 if the operand is 0, else 0).
      return mod.i32.eqz(emitExpression(node.value, layout, mod, binaryen));
    case "sqrt":
      return floatNs(mod, node.type).sqrt(emitExpression(node.value, layout, mod, binaryen));
    case "floor":
      return floatNs(mod, node.type).floor(emitExpression(node.value, layout, mod, binaryen));
    case "ceil":
      return floatNs(mod, node.type).ceil(emitExpression(node.value, layout, mod, binaryen));
    // frac(x) = x - floor(x) (= GLSL fract, result in [0,1)). x is tee'd into
    // FRAC_F32_LOCAL so it is evaluated once, then re-fetched on the floor side
    // with get (= avoids double evaluation).
    case "frac": {
      if (node.type === "f64") {
        const teedF64 = mod.local.tee(
          FRAC_F64_LOCAL,
          emitExpression(node.value, layout, mod, binaryen),
          binaryen.f64,
        );
        return mod.f64.sub(teedF64, mod.f64.floor(mod.local.get(FRAC_F64_LOCAL, binaryen.f64)));
      }
      const teed = mod.local.tee(
        FRAC_F32_LOCAL,
        emitExpression(node.value, layout, mod, binaryen),
        binaryen.f32,
      );
      return mod.f32.sub(teed, mod.f32.floor(mod.local.get(FRAC_F32_LOCAL, binaryen.f32)));
    }
    // The polynomial-approximation math primitives call a shared function
    // (= `(f32) -> f32`). The f64 form uses the f32 bridge: demote → call →
    // promote (= Q17 = the type-agnostic approximate-math contract, precision
    // f32-equivalent ~1e-4).
    case "sin":
    case "cos":
    case "tan":
    case "exp":
    case "log":
    case "tanh":
      return emitTranscendental(
        mod,
        binaryen,
        node.kind,
        node.type,
        emitExpression(node.value, layout, mod, binaryen),
      );
    case "max":
    case "min":
      return emitMaxMin(
        mod,
        node.type,
        node.kind,
        () => emitExpression(node.lhs, layout, mod, binaryen),
        () => emitExpression(node.rhs, layout, mod, binaryen),
      );
    // Comparison (= result is i32 0/1 = the internal bool representation, matching
    // the existing bool=i32 representation used by state.bool / select cond /
    // emitIf cond).
    case "eq":
      return emitNumericBinary(
        mod,
        node.type,
        "eq",
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "lt":
      return emitNumericBinary(
        mod,
        node.type,
        "lt",
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "gt":
      return emitNumericBinary(
        mod,
        node.type,
        "gt",
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "lte":
      return emitNumericBinary(
        mod,
        node.type,
        "le",
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "gte":
      return emitNumericBinary(
        mod,
        node.type,
        "ge",
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    // clamp(x, lo, hi) = min(max(x, lo), hi). Each operand is emitted exactly once
    // = no double evaluation = no temp local needed. The degenerate lo > hi case
    // returns hi (= max(x,lo) >= lo > hi, so min(..., hi) = hi), a deterministic
    // behavior.
    case "clamp":
      // clamp(x, lo, hi) = min(max(x, lo), hi). Integers go through emitMaxMin's
      // compare+select (= avoids the malformed WASM of f32.min/max with integer
      // operands); floats use native f{32,64}.
      return emitMaxMin(
        mod,
        node.type,
        "min",
        () =>
          emitMaxMin(
            mod,
            node.type,
            "max",
            () => emitExpression(node.x, layout, mod, binaryen),
            () => emitExpression(node.lo, layout, mod, binaryen),
          ),
        () => emitExpression(node.hi, layout, mod, binaryen),
      );
    // select(cond, then, else) = WASM `select` instruction (= eager: evaluates all
    // 3 arguments before choosing). then / else are pure side-effect-free
    // expressions, so eager evaluation does not change the meaning. cond is i32
    // (= bool 0/1).
    case "select":
      return mod.select(
        emitExpression(node.cond, layout, mod, binaryen),
        emitExpression(node.ifTrue, layout, mod, binaryen),
        emitExpression(node.ifFalse, layout, mod, binaryen),
      );
    case "convert":
      return emitConvert(
        mod,
        node.from,
        node.type,
        emitExpression(node.value, layout, mod, binaryen),
      );
    case "bufferRead": {
      const base = layout.regions.buffers.slots[node.name];
      if (base === undefined) {
        throw new Error(`unknown buffer: ${node.name}`);
      }
      const ptr = bufferElementPtr(
        mod,
        base,
        node.elementType,
        emitExpression(node.index, layout, mod, binaryen),
      );
      return emitBufferLoad(mod, node.elementType, ptr);
    }
    case "bufferReadInterpolated":
      return emitBufferReadInterpolated(node, layout, mod, binaryen);
    case "payloadFieldRead":
      return emitPayloadFieldRead(node, layout, mod, binaryen);
    case "payloadFieldLength":
      return emitPayloadFieldLength(node, layout, mod, binaryen);
    // SIMD lane extraction = f32x4.extract_lane (= constant lane index).
    case "vecLane":
      return mod.f32x4.extract_lane(emitVec(node.value, layout, mod, binaryen), node.index);
    // sumLanes = hold vec in a v128 local, then extract + add the 4 lanes (= §7).
    case "vecSumLanes": {
      const lane = (idx: number): number =>
        mod.f32x4.extract_lane(mod.local.get(VEC_TEMP_LOCAL, binaryen.v128), idx);
      return mod.block(
        null,
        [
          mod.local.set(VEC_TEMP_LOCAL, emitVec(node.value, layout, mod, binaryen)),
          mod.f32.add(mod.f32.add(lane(0), lane(1)), mod.f32.add(lane(2), lane(3))),
        ],
        binaryen.f32,
      );
    }
    // A vec-producing node does not appear in scalar position (= consumed via emitVec).
    case "vecConst":
    case "vecSplat":
    case "vecAdd":
    case "vecSub":
    case "vecMul":
    case "vecDiv":
    case "bufferLoadVec":
      throw new Error(`f32x4 node '${node.kind}' cannot appear in scalar position`);
    case "audioInRead": {
      const portBase = layout.regions.ioScratch.inputs[node.portName];
      if (portBase === undefined) {
        throw new Error(`unknown audioInput port: ${node.portName}`);
      }
      const channelBase = portBase + node.channel * CHANNEL_STRIDE_BYTES;
      const ptr = mod.i32.add(
        mod.i32.const(channelBase),
        mod.i32.mul(
          emitExpression(node.offset, layout, mod, binaryen),
          mod.i32.const(BYTES_PER_F32),
        ),
      );
      return mod.f32.load(0, BYTES_PER_F32, ptr);
    }
    case "paramAt": {
      const paramBase = layout.regions.ioScratch.params[node.paramName];
      if (paramBase === undefined) {
        throw new Error(`unknown param: ${node.paramName}`);
      }
      const ptr = mod.i32.add(
        mod.i32.const(paramBase),
        mod.i32.mul(
          emitExpression(node.offset, layout, mod, binaryen),
          mod.i32.const(BYTES_PER_F32),
        ),
      );
      return mod.f32.load(0, BYTES_PER_F32, ptr);
    }
    case "stateLoad": {
      const slotOffset = layout.regions.states.slots[node.name];
      if (slotOffset === undefined) {
        throw new Error(`unknown state slot: ${node.name}`);
      }
      const ptr = mod.i32.const(slotOffset);
      switch (node.type) {
        case "f32":
          return mod.f32.load(0, BYTES_PER_F32, ptr);
        case "f64":
          return mod.f64.load(0, BYTES_PER_F64, ptr);
        case "i32":
          return mod.i32.load(0, BYTES_PER_I32, ptr);
        case "i64":
          return mod.i64.load(0, BYTES_PER_I64, ptr);
        case "bool":
          // bool has the internal i32 representation (= 0 / 1) and is used by the
          // caller via `select` / `lt` etc. (= matches Q42 + the sub-phase 7.4
          // SAB publish path).
          return mod.i32.load(0, BYTES_PER_I32, ptr);
      }
    }
    case "messageFieldRead": {
      // Inside the drain loop, MESSAGE_SLOT_PTR (= shared with EVENT_SLOT_PTR_LOCAL)
      // is already set = fetch it via local.get and memory.load at + the field offset.
      const slot = layout.regions.messageRings.slots[node.name];
      /* v8 ignore next 3 — the slot is already checked in emitMessageOnReceive =
         unreachable defensive guard */
      if (slot === undefined) {
        throw new Error(`unknown message slot: ${node.name}`);
      }
      const field = slot.fields.find((f) => f.name === node.field);
      /* v8 ignore next 3 — the field name is already pushed to decl.fields via the
         capture proxy = unreachable defensive guard */
      if (field === undefined) {
        throw new Error(`unknown message field: ${node.name}.${node.field}`);
      }
      const ptr = mod.i32.add(
        mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32),
        mod.i32.const(field.offsetInSlot),
      );
      // With the Q46 uniform lift, the sub-phase 7.7 stage seals only
      // wireType = i32 / bool; f32 / f64 / i64 are filled in a later sub-phase
      // alongside the typed-array path.
      if (field.wireType === "i32" || field.wireType === "bool") {
        return mod.i32.load(0, BYTES_PER_I32, ptr);
      }
      /* v8 ignore next 3 — the Q46 uniform lift path seals only wireType = i32 /
         bool = unreachable defensive guard */
      throw new Error(
        `unworklet: unsupported event field wireType "${field.wireType}" (= the sub-phase 7.7 stage supports only i32 / bool)`,
      );
    }
    case "tempRef":
      // Read the per-read temp local (= issue #8). The matching `tempAssign`
      // ran earlier in statement order, so the local is already set.
      return mod.local.get(TEMP_LOCAL_BASE + node.tempId, binaryenTypeOf(node.type, binaryen));
    case "midiFieldRead":
      return emitMidiFieldRead(node, mod, binaryen);
    case "midiSysexLength":
      return emitMidiSysexLength(node, layout, mod, binaryen);
    case "audioOutWrite":
    case "forSample":
    case "stateStore":
    case "eventEmitIf":
    case "messageOnReceive":
    case "bufferWrite":
    case "bufferCopyFrom":
    case "bufferStoreVec":
    case "everyNSamples":
    case "tempAssign":
    case "midiOnEvent":
    case "midiEmitIf":
    case "midiSysexCopy":
      throw new Error(`statement node '${node.kind}' cannot appear in expression position`);
  }
}

export function emitStatement(
  node: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  switch (node.kind) {
    case "stateStore": {
      const slotOffset = layout.regions.states.slots[node.name];
      if (slotOffset === undefined) {
        throw new Error(`unknown state slot: ${node.name}`);
      }
      const ptr = mod.i32.const(slotOffset);
      switch (node.type) {
        case "f32":
          return mod.f32.store(
            0,
            BYTES_PER_F32,
            ptr,
            emitSubnormalGuardF32(node.value, layout, mod, binaryen),
          );
        case "f64":
          return mod.f64.store(
            0,
            BYTES_PER_F64,
            ptr,
            emitSubnormalGuardF64(node.value, layout, mod, binaryen),
          );
        case "i32":
          return mod.i32.store(
            0,
            BYTES_PER_I32,
            ptr,
            emitExpression(node.value, layout, mod, binaryen),
          );
        case "i64":
          return mod.i64.store(
            0,
            BYTES_PER_I64,
            ptr,
            emitExpression(node.value, layout, mod, binaryen),
          );
        case "bool":
          // bool has the internal i32 representation (= store is also i32.store, no subnormal guard)
          return mod.i32.store(
            0,
            BYTES_PER_I32,
            ptr,
            emitExpression(node.value, layout, mod, binaryen),
          );
      }
    }
    case "audioOutWrite": {
      const portBase = layout.regions.ioScratch.outputs[node.portName];
      if (portBase === undefined) {
        throw new Error(`unknown audioOutput port: ${node.portName}`);
      }
      const channelBase = portBase + node.channel * CHANNEL_STRIDE_BYTES;
      const ptr = mod.i32.add(
        mod.i32.const(channelBase),
        mod.i32.mul(
          emitExpression(node.offset, layout, mod, binaryen),
          mod.i32.const(BYTES_PER_F32),
        ),
      );
      return mod.f32.store(
        0,
        BYTES_PER_F32,
        ptr,
        emitExpression(node.value, layout, mod, binaryen),
      );
    }
    case "forSample": {
      // Depth 0 keeps LOOP_COUNTER_LOCAL (byte-identical to the single-loop case);
      // deeper levels get a fresh local appended after the temp locals.
      const depth = node.depth ?? 0;
      const counterLocal = loopCounterLocal(depth);
      if (depth + 1 > loopEmit.maxDepth) loopEmit.maxDepth = depth + 1;
      const loopBody = node.body.map((s) => emitStatement(s, layout, mod, binaryen));
      // Depth 0 keeps the bare break/continue labels; nested levels get a per-depth
      // suffix so a nested loop never aliases the outer targets. Label names are not
      // in the WASM binary (branches encode as relative depths), so this is
      // byte-identical to the single-loop form.
      const brk = depth === 0 ? "break" : `break_${depth}`;
      const cont = depth === 0 ? "continue" : `continue_${depth}`;
      return mod.block(null, [
        mod.local.set(counterLocal, mod.i32.const(0)),
        mod.block(brk, [
          mod.loop(
            cont,
            mod.block(null, [
              mod.br_if(
                brk,
                mod.i32.ge_s(mod.local.get(counterLocal, binaryen.i32), mod.i32.const(128)),
              ),
              ...loopBody,
              mod.local.set(
                counterLocal,
                mod.i32.add(mod.local.get(counterLocal, binaryen.i32), mod.i32.const(node.stride)),
              ),
              mod.br(cont),
            ]),
          ),
        ]),
      ]);
    }
    case "bufferWrite": {
      const base = layout.regions.buffers.slots[node.name];
      if (base === undefined) {
        throw new Error(`unknown buffer: ${node.name}`);
      }
      const ptr = bufferElementPtr(
        mod,
        base,
        node.elementType,
        emitExpression(node.index, layout, mod, binaryen),
      );
      return emitBufferStore(
        mod,
        node.elementType,
        ptr,
        emitExpression(node.value, layout, mod, binaryen),
      );
    }
    case "bufferCopyFrom":
      return emitBufferCopyFrom(node, layout, mod, binaryen);
    case "bufferStoreVec": {
      const base = layout.regions.buffers.slots[node.name];
      /* v8 ignore next 3 — the buffer is declared = its slot is already pushed in layout = unreachable */
      if (base === undefined) {
        throw new Error(`unknown buffer: ${node.name}`);
      }
      const addr = mod.i32.add(
        mod.i32.const(base),
        mod.i32.mul(
          emitExpression(node.offset, layout, mod, binaryen),
          mod.i32.const(BYTES_PER_F32),
        ),
      );
      return mod.v128.store(0, BYTES_PER_F32, addr, emitVec(node.value, layout, mod, binaryen));
    }
    case "everyNSamples": {
      // §9.1: run the body when (counter % divisor) == 0, then counter += stride.
      // The counter persists across blocks in a per-call-site memory slot
      // (= zero-order hold arises naturally because the body's state.store retains
      // the value).
      const counterOffset = layout.regions.everyNSamplesCounters.slots[node.counterId];
      /* v8 ignore next 3 — counterId is numbered at capture + its slot is reserved by layout = unreachable */
      if (counterOffset === undefined) {
        throw new Error(`unworklet: missing everyNSamples counter slot ${node.counterId}`);
      }
      const loadCounter = (): number =>
        mod.i32.load(0, BYTES_PER_I32, mod.i32.const(counterOffset));
      const bodyEmits = node.body.map((s) => emitStatement(s, layout, mod, binaryen));
      return mod.block(null, [
        mod.if(
          mod.i32.eq(mod.i32.rem_u(loadCounter(), mod.i32.const(node.divisor)), mod.i32.const(0)),
          mod.block(null, bodyEmits.length > 0 ? bodyEmits : [mod.nop()]),
        ),
        mod.i32.store(
          0,
          BYTES_PER_I32,
          mod.i32.const(counterOffset),
          mod.i32.add(loadCounter(), mod.i32.const(node.stride)),
        ),
      ]);
    }
    case "eventEmitIf":
      return emitEventEmitIf(node, layout, mod, binaryen);
    /* v8 ignore next 2 — messageOnReceive is reordered at the emit top level and
       calls emitMessageOnReceive directly = never reached via emitStatement */
    case "messageOnReceive":
      return emitMessageOnReceive(node, layout, mod, binaryen);
    case "tempAssign":
      // Evaluate a mutable read once into its per-read local (= issue #8).
      return mod.local.set(
        TEMP_LOCAL_BASE + node.tempId,
        emitExpression(node.value, layout, mod, binaryen),
      );
    case "midiEmitIf":
      return emitMidiEmitIf(node, layout, mod, binaryen);
    case "midiSysexCopy":
      return emitMidiSysexCopy(node, layout, mod, binaryen);
    /* v8 ignore next 3 — midiOnEvent is reordered per port at the emit top level and
       calls emitMidiInputDrain directly = never reached via emitStatement */
    case "midiOnEvent":
      return emitMidiInputDrain(node.port, [node], layout, mod, binaryen);
    default:
      throw new Error(`expression node '${node.kind}' cannot appear in statement position`);
  }
}

/**
 * Subnormal guard emit (= the WASM IR for `|v| < 1e-30 ? 0 : v`, Q21).
 * Automatically inlined by f32 / f64 `state.store(v)`.
 *
 * In the form `block(name, [local.set(v), expression_using_local.get], type)`, v
 * is evaluated once and stored in a local, then the subsequent expression
 * references `local.get` twice (= once in the abs / lt condition, once in the
 * select else). The naive "emit v twice" path became a trigger for binaryen to
 * produce NaN "in the context of an audioInRead after forSample" (= measured),
 * and was resolved by refactoring to a single-evaluation-via-local path.
 */
function emitSubnormalGuardF32(
  valueNode: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  // WASM `select` is eager evaluation = it evaluates all 3 arguments before
  // choosing. This triggered a pitfall where the `local.get` inside ifFalse was
  // "evaluated before `local.tee`" and picked up the local's initial value 0
  // (= measured). `if-else` is lazy evaluation = the condition runs `local.tee`
  // first, then only one of then / else is evaluated = the else-side `local.get`
  // runs only after the local is guaranteed to hold v.
  const v = emitExpression(valueNode, layout, mod, binaryen);
  const teed = mod.local.tee(SUBNORMAL_F32_LOCAL, v, binaryen.f32);
  return mod.if(
    mod.f32.lt(mod.f32.abs(teed), mod.f32.const(SUBNORMAL_THRESHOLD)),
    mod.f32.const(0),
    mod.local.get(SUBNORMAL_F32_LOCAL, binaryen.f32),
  );
}

function emitSubnormalGuardF64(
  valueNode: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const v = emitExpression(valueNode, layout, mod, binaryen);
  const teed = mod.local.tee(SUBNORMAL_F64_LOCAL, v, binaryen.f64);
  return mod.if(
    mod.f64.lt(mod.f64.abs(teed), mod.f64.const(SUBNORMAL_THRESHOLD)),
    mod.f64.const(0),
    mod.local.get(SUBNORMAL_F64_LOCAL, binaryen.f64),
  );
}

const EVENT_HEADER_BYTES = 12;
const EVENT_HEAD_OFFSET = 0;
const EVENT_TAIL_OFFSET = 4;
const EVENT_OVERFLOW_OFFSET = 8;

/**
 * `event.emitIf` WASM emit (= sub-phase 7.6 commit 4, `02-messaging.md` §4 + §5.1).
 *
 * The fire path, when cond is truthy:
 * 1. load head once + hold it in `EVENT_HEAD_LOCAL`
 * 2. overflow check (= head + 1 - tail >= capacity) → drop-oldest:
 *    overflowCount += 1 + tail += 1
 * 3. compute slot ptr = base + 12 + (head % capacity) × slotSize once + hold it
 *    in `EVENT_SLOT_PTR_LOCAL`
 * 4. store atSample + each field into the slot (= matching the per-field offset /
 *    wireType of layout.regions.eventRings.slots[name].fields)
 * 5. store head += 1
 *
 * SAB Atomics are reflected in the worklet template (= commit 5); here it is just
 * plain memory.load / store.
 */
function emitEventEmitIf(
  node: AstNode & { kind: "eventEmitIf" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const slot = layout.regions.eventRings.slots[node.name];
  if (slot === undefined) {
    throw new Error(`unknown event slot: ${node.name}`);
  }
  const ringBase = slot.base;
  const capacity = slot.capacity;
  const slotSize = slot.slotSize;
  const slotsBase = ringBase + EVENT_HEADER_BYTES;

  // value lookup helper (= AST field value AST → WASM expr), emitted matching the
  // layout fields (= atSample first, then payload order)
  const fieldValueByName = new Map<string, AstNode>([
    ["atSample", node.atSample],
    ...node.fields.map((f) => [f.name, f.value] as const),
  ]);
  // Emit metadata for typed-array fields (§4.3) (= bufferName + length + elementType).
  const emitFieldByName = new Map(node.fields.map((f) => [f.name, f] as const));

  // overflow check + drop-oldest (= ring full = when distance head - tail >=
  // capacity it is already filled = the next emit overwrites the oldest slot =
  // drop-oldest).
  // Variant B rule (= `02-messaging.md` §5.1): reflects "capacity = how many can
  // be filled" directly from the user's viewpoint, and because head / tail are
  // held as monotonically increasing i32, the textbook ring-buffer convention of
  // "leave one extra slot empty" is unnecessary.
  const overflowBlock = mod.if(
    mod.i32.ge_s(
      mod.i32.sub(
        mod.local.get(EVENT_HEAD_LOCAL, binaryen.i32),
        mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + EVENT_TAIL_OFFSET)),
      ),
      mod.i32.const(capacity),
    ),
    mod.block(null, [
      mod.i32.store(
        0,
        BYTES_PER_I32,
        mod.i32.const(ringBase + EVENT_OVERFLOW_OFFSET),
        mod.i32.add(
          mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + EVENT_OVERFLOW_OFFSET)),
          mod.i32.const(1),
        ),
      ),
      mod.i32.store(
        0,
        BYTES_PER_I32,
        mod.i32.const(ringBase + EVENT_TAIL_OFFSET),
        mod.i32.add(
          mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + EVENT_TAIL_OFFSET)),
          mod.i32.const(1),
        ),
      ),
    ]),
  );

  // slot ptr = slotsBase + (head % capacity) × slotSize, computed once + held in a local
  const slotPtrTee = mod.local.tee(
    EVENT_SLOT_PTR_LOCAL,
    mod.i32.add(
      mod.i32.const(slotsBase),
      mod.i32.mul(
        mod.i32.rem_u(mod.local.get(EVENT_HEAD_LOCAL, binaryen.i32), mod.i32.const(capacity)),
        mod.i32.const(slotSize),
      ),
    ),
    binaryen.i32,
  );

  // The store statement for each field (= in layout.fields order)
  const fieldStores: number[] = [];
  for (let idx = 0; idx < slot.fields.length; idx++) {
    const field = slot.fields[idx]!;
    const valueAst = fieldValueByName.get(field.name);
    /* v8 ignore next 3 — ruled out by the seal of the first emit at the capture
       stage + the field-set consistency check of subsequent emits = structurally
       unreachable defensive guard */
    if (valueAst === undefined) {
      throw new Error(`event "${node.name}" missing AST for field "${field.name}"`);
    }
    // typed-array field (§4.3 worklet→main) = memory.copy the buffer's content
    // into the event content region + store [payloadLen, payloadOffset] into the
    // slot. payloadOffset = (head % capacity) × chunkBytes (= the fixed per-slot
    // chunk, chunkBytes = content.capacity / ring capacity = perPayload). Because
    // main drains all at once after the render, content must be held separately
    // per slot. copyBytes = min(length × sizeof, chunkBytes). Since atSample is
    // always idx 0, a typed-array field is idx ≥ 1 = after slotPtrTee =
    // EVENT_SLOT_PTR_LOCAL is already fixed.
    if (field.payloadElementType !== undefined) {
      const emitField = emitFieldByName.get(field.name);
      const content = layout.regions.payloadContent.eventSlots[node.name];
      const bufferBase =
        emitField?.bufferName !== undefined
          ? layout.regions.buffers.slots[emitField.bufferName]
          : undefined;
      /* v8 ignore next 6 — a typed-array emit field is pushed in declarations with
         bufferName + length + payloadContent all present = structurally unreachable guard */
      if (
        emitField?.length === undefined ||
        emitField.bufferSize === undefined ||
        content === undefined ||
        bufferBase === undefined
      ) {
        throw new Error(`event "${node.name}" typed-array field "${field.name}" missing emit meta`);
      }
      const elemBytes = BUFFER_ELEMENT_BYTES_EMIT[field.payloadElementType];
      // The chunk cycles within the content.chunks budget (= min(capacity,
      // MAX_CONTENT_SLOTS), Q85). Even when ring capacity exceeds chunks, content
      // reuses the chunks budget drop-oldest.
      const chunkBytes = Math.floor(content.capacity / content.chunks);
      // Copy upper bound = the smaller of the chunk and the source buffer. Without
      // this, when length exceeds the buffer size (= author misspecification),
      // memory.copy would read past the buffer.<T> region into adjacent linear
      // memory and publish those bytes to main (= memory disclosure).
      const bufferBytes = emitField.bufferSize * elemBytes;
      const copyCap = Math.min(chunkBytes, bufferBytes);
      const slotFieldPtr = (): number =>
        mod.i32.add(
          mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32),
          mod.i32.const(field.offsetInSlot),
        );
      const payloadOffset = (): number =>
        mod.i32.mul(
          mod.i32.rem_u(
            mod.local.get(EVENT_HEAD_LOCAL, binaryen.i32),
            mod.i32.const(content.chunks),
          ),
          mod.i32.const(chunkBytes),
        );
      const lengthBytes = (): number =>
        mod.i32.mul(
          emitExpression(emitField.length!, layout, mod, binaryen),
          mod.i32.const(elemBytes),
        );
      // copyBytes = min(length × sizeof, copyCap). With an unsigned comparison, a
      // negative length becomes a huge unsigned value and rounds down to copyCap
      // (= stays within [0, copyCap], so no OOB read).
      const copyBytes = (): number =>
        mod.select(
          mod.i32.lt_u(lengthBytes(), mod.i32.const(copyCap)),
          lengthBytes(),
          mod.i32.const(copyCap),
        );
      fieldStores.push(
        mod.block(null, [
          mod.i32.store(0, BYTES_PER_I32, slotFieldPtr(), copyBytes()), // payloadLen
          mod.i32.store(
            0,
            BYTES_PER_I32,
            mod.i32.add(slotFieldPtr(), mod.i32.const(4)),
            payloadOffset(),
          ), // payloadOffset
          mod.memory.copy(
            mod.i32.add(mod.i32.const(content.base), payloadOffset()),
            mod.i32.const(bufferBase),
            copyBytes(),
          ),
        ]),
      );
      continue;
    }
    const ptr =
      idx === 0
        ? slotPtrTee // hold in the local at the first store
        : mod.i32.add(
            mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32),
            mod.i32.const(field.offsetInSlot),
          );
    const valueExpr = emitExpression(valueAst, layout, mod, binaryen);
    switch (field.wireType) {
      case "f32":
        fieldStores.push(mod.f32.store(0, BYTES_PER_F32, ptr, valueExpr));
        break;
      case "f64":
        fieldStores.push(mod.f64.store(0, BYTES_PER_F64, ptr, valueExpr));
        break;
      case "i32":
      case "bool":
        fieldStores.push(mod.i32.store(0, BYTES_PER_I32, ptr, valueExpr));
        break;
      case "i64":
        fieldStores.push(mod.i64.store(0, BYTES_PER_I64, ptr, valueExpr));
        break;
    }
  }

  // fire body: head load + overflow check + slot fill + head += 1
  const fireBlock = mod.block(null, [
    mod.local.set(
      EVENT_HEAD_LOCAL,
      mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + EVENT_HEAD_OFFSET)),
    ),
    overflowBlock,
    ...fieldStores,
    mod.i32.store(
      0,
      BYTES_PER_I32,
      mod.i32.const(ringBase + EVENT_HEAD_OFFSET),
      mod.i32.add(mod.local.get(EVENT_HEAD_LOCAL, binaryen.i32), mod.i32.const(1)),
    ),
  ]);

  return mod.if(emitExpression(node.cond, layout, mod, binaryen), fireBlock);
}

/**
 * `message.onReceive` drain emit (= sub-phase 7.7c, `02-messaging.md` §5.3).
 *
 * At the start of each quantum, drain the relevant ring (= walk tail → head and
 * run the handler body at each slot). At the end of the drain, commit tail to
 * head (= fully consume, within one quantum, every slot that main pushed via
 * Atomics.store(head)).
 *
 * Loop form:
 *   $tail = load(base + 4)
 *   $head = load(base + 0)
 *   block break
 *     loop continue
 *       if ($tail == $head) br break
 *       $slot_ptr = base + 12 + ($tail % capacity) × slotSize
 *       <handler body>  (messageFieldRead is at $slot_ptr + field.offsetInSlot)
 *       $tail += 1
 *       br continue
 *   store(base + 4, $tail)
 */
function emitMessageOnReceive(
  node: AstNode & { kind: "messageOnReceive" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const slot = layout.regions.messageRings.slots[node.name];
  if (slot === undefined) {
    throw new Error(`unknown message slot: ${node.name}`);
  }
  const ringBase = slot.base;
  const capacity = slot.capacity;
  const slotSize = slot.slotSize;
  const slotsBase = ringBase + EVENT_HEADER_BYTES;
  const HEAD_OFFSET = 0;
  const TAIL_OFFSET = 4;

  // handler body emit (= messageFieldRead resolves via $slot_ptr through the
  // existing emit path).
  const bodyEmits = node.body.map((s) => emitStatement(s, layout, mod, binaryen));

  return mod.block(null, [
    mod.local.set(
      MESSAGE_TAIL_LOCAL,
      mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + TAIL_OFFSET)),
    ),
    mod.local.set(
      EVENT_HEAD_LOCAL,
      mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + HEAD_OFFSET)),
    ),
    mod.block("break", [
      mod.loop(
        "continue",
        mod.block(null, [
          mod.br_if(
            "break",
            mod.i32.eq(
              mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32),
              mod.local.get(EVENT_HEAD_LOCAL, binaryen.i32),
            ),
          ),
          mod.local.set(
            EVENT_SLOT_PTR_LOCAL,
            mod.i32.add(
              mod.i32.const(slotsBase),
              slotSize === 0
                ? mod.i32.const(0)
                : mod.i32.mul(
                    mod.i32.rem_u(
                      mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32),
                      mod.i32.const(capacity),
                    ),
                    mod.i32.const(slotSize),
                  ),
            ),
          ),
          ...bodyEmits,
          mod.local.set(
            MESSAGE_TAIL_LOCAL,
            mod.i32.add(mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32), mod.i32.const(1)),
          ),
          mod.br("continue"),
        ]),
      ),
    ]),
    mod.i32.store(
      0,
      BYTES_PER_I32,
      mod.i32.const(ringBase + TAIL_OFFSET),
      mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32),
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// MIDI (`11-midi.md` §4). 8-byte slot [status, data1, data2, _pad, atSample:u32].
// inbound = at the block boundary, drain the port's ring + dispatch by type on
// the status high nibble.
// outbound = `emitIf` encodes semantic args → wire bytes and pushes to the ring.
// ─────────────────────────────────────────────────────────────────────────

const MIDI_SLOT_BYTES_EMIT = 8;
const MIDI_HEADER_BYTES_EMIT = 12;
const MIDI_TAIL_OFFSET = 4;
const MIDI_OVERFLOW_OFFSET = 8;

/** The status high nibble of a channel-voice event (= `11-midi.md` §4.1). */
const MIDI_STATUS_NIBBLE: Partial<Record<string, number>> = {
  noteOff: 0x80,
  noteOn: 0x90,
  aftertouch: 0xa0,
  cc: 0xb0,
  programChange: 0xc0,
  channelPressure: 0xd0,
  pitchBend: 0xe0,
};

/** `midiFieldRead` (= decode drain-slot bytes, via EVENT_SLOT_PTR_LOCAL). */
function emitMidiFieldRead(
  field: AstNode & { kind: "midiFieldRead" },
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const ptr = (): number => mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32);
  switch (field.field) {
    case "status":
      return mod.i32.load8_u(0, 1, ptr());
    case "channel":
      return mod.i32.and(mod.i32.load8_u(0, 1, ptr()), mod.i32.const(0x0f));
    case "data1":
      return mod.i32.load8_u(1, 1, ptr());
    case "data2":
      return mod.i32.load8_u(2, 1, ptr());
    case "atSample":
      return mod.i32.load(4, BYTES_PER_I32, ptr());
    case "pitchBend14":
      // value = data1 | (data2 << 7) (= 14-bit, `11-midi.md` §4.1).
      return mod.i32.or(
        mod.i32.load8_u(1, 1, ptr()),
        mod.i32.shl(mod.i32.load8_u(2, 1, ptr()), mod.i32.const(7)),
      );
  }
}

/**
 * Address of the current inbound drain slot's sysex content chunk (`11-midi.md`
 * §4.3): `contentBase + chunkIdx × perChunk`, where `chunkIdx` = the slot's
 * data1 byte (= EVENT_SLOT_PTR_LOCAL + 1). The chunk is `[length:u32, bytes...]`.
 */
function sysexContentChunkPtr(
  port: string,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const region = layout.regions.sysexContent.slots[port];
  /* v8 ignore next 2 — a port that uses sysex has its content region reserved by layout */
  if (region === undefined)
    throw new Error(`unworklet: midiInput "${port}" has no sysex content region`);
  return mod.i32.add(
    mod.i32.const(region.base),
    mod.i32.mul(
      mod.i32.load8_u(1, 1, mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32)),
      mod.i32.const(region.perChunk),
    ),
  );
}

/** `midiSysexLength` = inbound sysex content-chunk length (= `[length:u32]` head). */
function emitMidiSysexLength(
  node: AstNode & { kind: "midiSysexLength" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  return mod.i32.load(0, BYTES_PER_I32, sysexContentChunkPtr(node.port, layout, mod, binaryen));
}

/** `midiSysexCopy` = bulk copy inbound sysex content chunk → a buffer.u8 (= §2.5). */
function emitMidiSysexCopy(
  node: AstNode & { kind: "midiSysexCopy" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const bufferBase = layout.regions.buffers.slots[node.bufferName];
  /* v8 ignore next 2 — the buffer is reserved by layout */
  if (bufferBase === undefined) throw new Error(`unknown buffer: ${node.bufferName}`);
  const chunkPtr = sysexContentChunkPtr(node.port, layout, mod, binaryen);
  // copy min(contentLength, bufferSize) bytes from chunk+4 (= after the length
  // header) into the buffer. Use BUFINTERP_I0_LOCAL as the chunk-ptr scratch so
  // the length re-read and the copy address agree.
  return mod.block(null, [
    mod.local.set(BUFINTERP_I0_LOCAL, chunkPtr),
    mod.memory.copy(
      mod.i32.const(bufferBase),
      mod.i32.add(mod.local.get(BUFINTERP_I0_LOCAL, binaryen.i32), mod.i32.const(4)),
      minI32(
        mod,
        mod.i32.load(0, BYTES_PER_I32, mod.local.get(BUFINTERP_I0_LOCAL, binaryen.i32)),
        mod.i32.const(node.bufferSize),
      ),
    ),
  ]);
}

/** `min` of two i32 expressions (each evaluated once). */
function minI32(mod: BinaryenModule, a: number, b: number): number {
  return mod.select(mod.i32.lt_s(a, b), a, b);
}

/**
 * Drain one `midiInput` port at the block boundary (Q38-b): walk tail→head,
 * and for each registered handler emit `if (status matches eventType) { body }`
 * (registration order, Q38-c). Handler `midiFieldRead` nodes resolve against
 * EVENT_SLOT_PTR_LOCAL (= the current slot pointer, shared with message drain).
 */
function emitMidiInputDrain(
  port: string,
  handlers: ReadonlyArray<AstNode & { kind: "midiOnEvent" }>,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const slot = layout.regions.midiRings.slots[port];
  /* v8 ignore next 2 — a midiInput port is always pushed by layout = unreachable */
  if (slot === undefined) throw new Error(`unknown midiInput port: ${port}`);
  const ringBase = slot.base;
  const capacity = slot.capacity;
  const slotsBase = ringBase + MIDI_HEADER_BYTES_EMIT;
  const status = (): number =>
    mod.i32.load8_u(0, 1, mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32));

  // status byte → event-type predicate. channel-voice = high-nibble match,
  // systemRealtime = 0xF8..0xFF (= status & 0xF8 == 0xF8).
  const predicate = (eventType: string): number => {
    if (eventType === "sysex") {
      return mod.i32.eq(status(), mod.i32.const(0xf0));
    }
    if (eventType === "systemRealtime") {
      return mod.i32.eq(mod.i32.and(status(), mod.i32.const(0xf8)), mod.i32.const(0xf8));
    }
    const nibble = MIDI_STATUS_NIBBLE[eventType]!;
    return mod.i32.eq(mod.i32.and(status(), mod.i32.const(0xf0)), mod.i32.const(nibble));
  };

  const dispatch: number[] = [];
  for (const h of handlers) {
    const body = h.body.map((s) => emitStatement(s, layout, mod, binaryen));
    dispatch.push(
      mod.if(predicate(h.eventType), mod.block(null, body.length > 0 ? body : [mod.nop()])),
    );
  }

  // The loop condition re-reads `head` from memory each iteration (not a cached
  // local): a handler may `emitIf` to another port, and that emit reuses
  // EVENT_HEAD_LOCAL / EVENT_SLOT_PTR_LOCAL — so the drain must not depend on
  // those surviving the handler body. `head` is stable during the drain (the
  // producer is main / injection, never the handler).
  return mod.block(null, [
    mod.local.set(
      MESSAGE_TAIL_LOCAL,
      mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + MIDI_TAIL_OFFSET)),
    ),
    mod.block("break", [
      mod.loop(
        "continue",
        mod.block(null, [
          mod.br_if(
            "break",
            mod.i32.eq(
              mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32),
              mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase)),
            ),
          ),
          mod.local.set(
            EVENT_SLOT_PTR_LOCAL,
            mod.i32.add(
              mod.i32.const(slotsBase),
              mod.i32.mul(
                mod.i32.rem_u(
                  mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32),
                  mod.i32.const(capacity),
                ),
                mod.i32.const(MIDI_SLOT_BYTES_EMIT),
              ),
            ),
          ),
          ...dispatch,
          mod.local.set(
            MESSAGE_TAIL_LOCAL,
            mod.i32.add(mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32), mod.i32.const(1)),
          ),
          mod.br("continue"),
        ]),
      ),
    ]),
    mod.i32.store(
      0,
      BYTES_PER_I32,
      mod.i32.const(ringBase + MIDI_TAIL_OFFSET),
      mod.local.get(MESSAGE_TAIL_LOCAL, binaryen.i32),
    ),
  ]);
}

/** Compute the [status, data1, data2] wire bytes for an outbound MIDI emit. */
function emitMidiWireBytes(
  node: AstNode & { kind: "midiEmitIf" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): { status: number; data1: number; data2: number } {
  const ch = (): number =>
    mod.i32.and(emitExpression(node.channel!, layout, mod, binaryen), mod.i32.const(0x0f));
  const mask7 = (v: number): number => mod.i32.and(v, mod.i32.const(0x7f));
  const arg1 = (): number => emitExpression(node.arg1!, layout, mod, binaryen);
  const arg2 = (): number => emitExpression(node.arg2!, layout, mod, binaryen);
  if (node.eventType === "systemRealtime") {
    return {
      status: mod.i32.and(arg1(), mod.i32.const(0xff)),
      data1: mod.i32.const(0),
      data2: mod.i32.const(0),
    };
  }
  const nibble = MIDI_STATUS_NIBBLE[node.eventType]!;
  const status = mod.i32.or(mod.i32.const(nibble), ch());
  if (node.eventType === "pitchBend") {
    const value = arg1();
    // 14-bit value → data1 = value & 0x7F, data2 = (value >> 7) & 0x7F.
    return {
      status,
      data1: mod.i32.and(value, mod.i32.const(0x7f)),
      data2: mod.i32.and(mod.i32.shr_u(value, mod.i32.const(7)), mod.i32.const(0x7f)),
    };
  }
  return { status, data1: mask7(arg1()), data2: mask7(arg2()) };
}

/** `midiOutput().emitIf(cond, event)` = serialize into the output ring (drop-oldest). */
function emitMidiEmitIf(
  node: AstNode & { kind: "midiEmitIf" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const slot = layout.regions.midiRings.slots[node.port];
  /* v8 ignore next 2 — a midiOutput port is always pushed by layout = unreachable */
  if (slot === undefined) throw new Error(`unknown midiOutput port: ${node.port}`);
  const ringBase = slot.base;
  const capacity = slot.capacity;
  const slotsBase = ringBase + MIDI_HEADER_BYTES_EMIT;

  const slotPtr = (): number => mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32);
  const head = (): number => mod.local.get(EVENT_HEAD_LOCAL, binaryen.i32);
  const atSample = emitExpression(node.atSample, layout, mod, binaryen);

  // Common prologue: load head, drop-oldest on overflow, compute the dest slot ptr.
  const prologue: number[] = [
    mod.local.set(EVENT_HEAD_LOCAL, mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase))),
    mod.if(
      mod.i32.ge_s(
        mod.i32.sub(
          head(),
          mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + MIDI_TAIL_OFFSET)),
        ),
        mod.i32.const(capacity),
      ),
      mod.block(null, [
        mod.i32.store(
          0,
          BYTES_PER_I32,
          mod.i32.const(ringBase + MIDI_OVERFLOW_OFFSET),
          mod.i32.add(
            mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + MIDI_OVERFLOW_OFFSET)),
            mod.i32.const(1),
          ),
        ),
        mod.i32.store(
          0,
          BYTES_PER_I32,
          mod.i32.const(ringBase + MIDI_TAIL_OFFSET),
          mod.i32.add(
            mod.i32.load(0, BYTES_PER_I32, mod.i32.const(ringBase + MIDI_TAIL_OFFSET)),
            mod.i32.const(1),
          ),
        ),
      ]),
    ),
  ];

  const advanceHead = mod.i32.store(
    0,
    BYTES_PER_I32,
    mod.i32.const(ringBase),
    mod.i32.add(head(), mod.i32.const(1)),
  );

  let body: number[];
  if (node.eventType === "sysex") {
    // Sysex: status=0xF0 + chunkIdx (= head % chunks) in data1; content chunk
    // `[length, bytes]` filled from the source (worklet buffer.u8 or an inbound
    // sysex content chunk for thru). Capture source ptr + copyLen BEFORE the
    // dest slot ptr overwrites EVENT_SLOT_PTR_LOCAL (thru reads the source slot).
    const region = layout.regions.sysexContent.slots[node.port];
    /* v8 ignore next 2 — a port that emits sysex has its content region reserved by layout */
    if (region === undefined)
      throw new Error(`unworklet: midiOutput "${node.port}" has no sysex content region`);
    const maxBody = region.perChunk - 4;
    const lengthExpr = node.sysexLength
      ? emitExpression(node.sysexLength, layout, mod, binaryen)
      : mod.i32.const(0);
    // SRC scratch = BUFINTERP_I0_LOCAL (= source byte address), LEN = PAYLOAD_CLAMP_LOCAL.
    let srcSet: number;
    if (node.sysexBufferName !== undefined) {
      const bufferBase = layout.regions.buffers.slots[node.sysexBufferName]!;
      srcSet = mod.local.set(BUFINTERP_I0_LOCAL, mod.i32.const(bufferBase));
    } else {
      // thru: source = source port's current drain chunk + 4 (after length header).
      const srcRegion = layout.regions.sysexContent.slots[node.sysexSourcePort!]!;
      srcSet = mod.local.set(
        BUFINTERP_I0_LOCAL,
        mod.i32.add(
          mod.i32.add(
            mod.i32.const(srcRegion.base),
            mod.i32.mul(mod.i32.load8_u(1, 1, slotPtr()), mod.i32.const(srcRegion.perChunk)),
          ),
          mod.i32.const(4),
        ),
      );
    }
    const chunkOffset = (): number =>
      mod.i32.mul(
        mod.i32.rem_u(head(), mod.i32.const(region.chunks)),
        mod.i32.const(region.perChunk),
      );
    const contentChunk = (): number => mod.i32.add(mod.i32.const(region.base), chunkOffset());
    body = [
      srcSet,
      mod.local.set(PAYLOAD_CLAMP_LOCAL, minI32(mod, lengthExpr, mod.i32.const(maxBody))),
      mod.local.set(
        EVENT_SLOT_PTR_LOCAL,
        mod.i32.add(
          mod.i32.const(slotsBase),
          mod.i32.mul(
            mod.i32.rem_u(head(), mod.i32.const(capacity)),
            mod.i32.const(MIDI_SLOT_BYTES_EMIT),
          ),
        ),
      ),
      // content chunk = [length:u32, bytes...]
      mod.i32.store(
        0,
        BYTES_PER_I32,
        contentChunk(),
        mod.local.get(PAYLOAD_CLAMP_LOCAL, binaryen.i32),
      ),
      mod.memory.copy(
        mod.i32.add(contentChunk(), mod.i32.const(4)),
        mod.local.get(BUFINTERP_I0_LOCAL, binaryen.i32),
        mod.local.get(PAYLOAD_CLAMP_LOCAL, binaryen.i32),
      ),
      // slot = [0xF0, chunkIdx, _pad, _pad, atSample]
      mod.i32.store8(0, 1, slotPtr(), mod.i32.const(0xf0)),
      mod.i32.store8(1, 1, slotPtr(), mod.i32.rem_u(head(), mod.i32.const(region.chunks))),
      mod.i32.store(4, BYTES_PER_I32, slotPtr(), atSample),
      advanceHead,
    ];
  } else {
    const { status, data1, data2 } = emitMidiWireBytes(node, layout, mod, binaryen);
    body = [
      mod.local.set(
        EVENT_SLOT_PTR_LOCAL,
        mod.i32.add(
          mod.i32.const(slotsBase),
          mod.i32.mul(
            mod.i32.rem_u(head(), mod.i32.const(capacity)),
            mod.i32.const(MIDI_SLOT_BYTES_EMIT),
          ),
        ),
      ),
      mod.i32.store8(0, 1, slotPtr(), status),
      mod.i32.store8(1, 1, slotPtr(), data1),
      mod.i32.store8(2, 1, slotPtr(), data2),
      mod.i32.store(4, BYTES_PER_I32, slotPtr(), atSample),
      advanceHead,
    ];
  }

  return mod.if(
    emitExpression(node.cond, layout, mod, binaryen),
    mod.block(null, [...prologue, ...body]),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shared-function emit for the polynomial-approximation math primitives (= Q17,
// sin / cos / tan / tanh / exp / log). Degree-5..7 minimax / Taylor, max error
// ~1e-4 = inaudible at 24-bit audio.
// no-trap invariant: integer conversion uses trunc_s_sat (= saturating /
// non-trapping); reinterpret / nearest / convert are non-trapping to begin with.
// ─────────────────────────────────────────────────────────────────────────

const TRANSCENDENTAL_KINDS: ReadonlySet<string> = new Set([
  "sin",
  "cos",
  "tan",
  "tanh",
  "exp",
  "log",
]);

/** Walk the graph's AST and collect the transcendental kinds actually used. */
function collectUsedMathKinds(graph: CapturedGraph): Set<string> {
  const used = new Set<string>();
  const visit = (node: AstNode): void => {
    if (TRANSCENDENTAL_KINDS.has(node.kind)) used.add(node.kind);
    switch (node.kind) {
      case "mul":
      case "add":
      case "sub":
      case "div":
      case "mod":
      case "max":
      case "min":
      case "eq":
      case "lt":
      case "gt":
      case "lte":
      case "gte":
        visit(node.lhs);
        visit(node.rhs);
        break;
      case "abs":
      case "neg":
      case "not":
      case "sqrt":
      case "floor":
      case "ceil":
      case "frac":
      case "sin":
      case "cos":
      case "tan":
      case "tanh":
      case "exp":
      case "log":
      case "convert":
        visit(node.value);
        break;
      case "clamp":
        visit(node.x);
        visit(node.lo);
        visit(node.hi);
        break;
      case "select":
        visit(node.cond);
        visit(node.ifTrue);
        visit(node.ifFalse);
        break;
      case "audioInRead":
      case "paramAt":
        visit(node.offset);
        break;
      case "audioOutWrite":
        visit(node.offset);
        visit(node.value);
        break;
      case "stateStore":
        visit(node.value);
        break;
      case "bufferRead":
        visit(node.index);
        break;
      case "bufferReadInterpolated":
        visit(node.pos);
        break;
      case "payloadFieldRead":
        visit(node.index);
        break;
      case "payloadFieldLength":
        break;
      case "bufferCopyFrom":
        // no child expression that contains a math function.
        break;
      case "vecConst":
        node.lanes.forEach(visit);
        break;
      case "vecSplat":
      case "vecLane":
      case "vecSumLanes":
        visit(node.value);
        break;
      case "vecAdd":
      case "vecSub":
      case "vecMul":
      case "vecDiv":
        visit(node.lhs);
        visit(node.rhs);
        break;
      case "bufferLoadVec":
        visit(node.offset);
        break;
      case "bufferStoreVec":
        visit(node.offset);
        visit(node.value);
        break;
      case "bufferWrite":
        visit(node.index);
        visit(node.value);
        break;
      case "forSample":
      case "messageOnReceive":
      case "everyNSamples":
        node.body.forEach(visit);
        break;
      case "eventEmitIf":
        visit(node.cond);
        visit(node.atSample);
        node.fields.forEach((field) => {
          visit(field.value);
          if (field.length !== undefined) visit(field.length);
        });
        break;
      case "tempAssign":
        visit(node.value);
        break;
      case "midiOnEvent":
        node.body.forEach(visit);
        break;
      case "midiEmitIf":
        visit(node.cond);
        visit(node.atSample);
        if (node.channel !== undefined) visit(node.channel);
        if (node.arg1 !== undefined) visit(node.arg1);
        if (node.arg2 !== undefined) visit(node.arg2);
        if (node.sysexLength !== undefined) visit(node.sysexLength);
        break;
      case "literal":
      case "loopCounter":
      case "stateLoad":
      case "tempRef":
      case "midiFieldRead":
      case "midiSysexLength":
      case "midiSysexCopy":
      case "messageFieldRead":
        break;
    }
  };
  graph.statements.forEach(visit);
  return used;
}

/**
 * Dependency expansion: cos / tan call sin, and tan also calls cos (= derived
 * implementations). Include the required base functions in the used set too.
 */
function expandMathDeps(used: Set<string>): Set<string> {
  const out = new Set(used);
  if (out.has("cos") || out.has("tan")) out.add("sin");
  if (out.has("tan")) out.add("cos");
  if (out.has("tanh")) out.add("exp");
  return out;
}

/** Add the shared math functions to the module according to the used kinds (= in dependency order). */
function addMathFunctions(used: Set<string>, mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const expanded = expandMathDeps(used);
  if (expanded.has("sin")) buildSinFn(mod, binaryen);
  if (expanded.has("cos")) buildCosFn(mod, binaryen);
  if (expanded.has("tan")) buildTanFn(mod, binaryen);
  if (expanded.has("exp")) buildExpFn(mod, binaryen);
  if (expanded.has("log")) buildLogFn(mod, binaryen);
  if (expanded.has("tanh")) buildTanhFn(mod, binaryen);
}

const MATH_PI = Math.PI;

/**
 * `$unworklet_sin`: range-reduce r = x - round(x/π)·π ∈ [-π/2, π/2], evaluate
 * sin(r) with a degree-9 odd Taylor series, and multiply by sign =
 * (-1)^round(x/π). The degree-9 Taylor error on [-π/2,π/2] is ~3e-5 (= ≤ 1e-4).
 * locals: 0=x(param) / 1=k_f / 2=r / 3=z(=r²) / 4=k_i.
 */
function buildSinFn(mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const f = binaryen.f32;
  const i = binaryen.i32;
  const X = 0;
  const KF = 1;
  const R = 2;
  const Z = 3;
  const KI = 4;
  const z = (): number => mod.local.get(Z, f);
  // sin(r) ≈ r·(1 + z·(-1/6 + z·(1/120 + z·(-1/5040 + z·(1/362880)))))
  let poly = mod.f32.add(mod.f32.const(-1 / 5040), mod.f32.mul(z(), mod.f32.const(1 / 362880)));
  poly = mod.f32.add(mod.f32.const(1 / 120), mod.f32.mul(z(), poly));
  poly = mod.f32.add(mod.f32.const(-1 / 6), mod.f32.mul(z(), poly));
  poly = mod.f32.add(mod.f32.const(1), mod.f32.mul(z(), poly));
  poly = mod.f32.mul(mod.local.get(R, f), poly);
  // sign = 1 - 2·(k_i & 1) ∈ {1, -1}
  const sign = mod.f32.convert_s.i32(
    mod.i32.sub(
      mod.i32.const(1),
      mod.i32.shl(mod.i32.and(mod.local.get(KI, i), mod.i32.const(1)), mod.i32.const(1)),
    ),
  );
  const body = mod.block(
    null,
    [
      mod.local.set(
        KF,
        mod.f32.nearest(mod.f32.mul(mod.local.get(X, f), mod.f32.const(1 / MATH_PI))),
      ),
      mod.local.set(KI, mod.i32.trunc_s_sat.f32(mod.local.get(KF, f))),
      mod.local.set(
        R,
        mod.f32.sub(mod.local.get(X, f), mod.f32.mul(mod.local.get(KF, f), mod.f32.const(MATH_PI))),
      ),
      mod.local.set(Z, mod.f32.mul(mod.local.get(R, f), mod.local.get(R, f))),
      mod.f32.mul(sign, poly),
    ],
    f,
  );
  mod.addFunction(`${MATH_FN_PREFIX}sin`, binaryen.f32, binaryen.f32, [f, f, f, i], body);
}

/** `$unworklet_cos`: cos(x) = sin(x + π/2), delegating to the sin function. No locals. */
function buildCosFn(mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const f = binaryen.f32;
  const body = mod.call(
    `${MATH_FN_PREFIX}sin`,
    [mod.f32.add(mod.local.get(0, f), mod.f32.const(MATH_PI / 2))],
    binaryen.f32,
  );
  mod.addFunction(`${MATH_FN_PREFIX}cos`, binaryen.f32, binaryen.f32, [], body);
}

/** `$unworklet_tan`: tan(x) = sin(x)/cos(x). x is a param local = freely re-fetched. */
function buildTanFn(mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const f = binaryen.f32;
  const body = mod.f32.div(
    mod.call(`${MATH_FN_PREFIX}sin`, [mod.local.get(0, f)], binaryen.f32),
    mod.call(`${MATH_FN_PREFIX}cos`, [mod.local.get(0, f)], binaryen.f32),
  );
  mod.addFunction(`${MATH_FN_PREFIX}tan`, binaryen.f32, binaryen.f32, [], body);
}

const MATH_LN2 = Math.LN2;

/**
 * `$unworklet_exp`: decompose x = k·ln2 + r (= k=round(x/ln2), r∈[-ln2/2,ln2/2]),
 * so exp(x) = 2^k · exp(r). exp(r) is a degree-5 Taylor (= error ~2.4e-6), and
 * 2^k reinterprets `(k+127)<<23` as f32. locals: 0=x(param) / 1=k_f / 2=r / 3=k_i.
 * When k is outside the f32 exponent range (= k>127 / k<-126), the bit-pack wraps
 * to garbage, so a select clamps overflow→+Inf / underflow→0 to conform to
 * `Math.exp` (= non-trapping). tanh likewise goes through exp(2x), so large
 * negative inputs saturate to ±1.
 */
function buildExpFn(mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const f = binaryen.f32;
  const i = binaryen.i32;
  const X = 0;
  const KF = 1;
  const R = 2;
  const KI = 3;
  const r = (): number => mod.local.get(R, f);
  // exp(r) ≈ 1 + r·(1 + r·(1/2 + r·(1/6 + r·(1/24 + r·(1/120)))))
  let poly = mod.f32.const(1 / 120);
  poly = mod.f32.add(mod.f32.const(1 / 24), mod.f32.mul(r(), poly));
  poly = mod.f32.add(mod.f32.const(1 / 6), mod.f32.mul(r(), poly));
  poly = mod.f32.add(mod.f32.const(1 / 2), mod.f32.mul(r(), poly));
  poly = mod.f32.add(mod.f32.const(1), mod.f32.mul(r(), poly));
  poly = mod.f32.add(mod.f32.const(1), mod.f32.mul(r(), poly));
  // 2^k = reinterpret_f32((k_i + 127) << 23)
  const twoK = mod.f32.reinterpret(
    mod.i32.shl(mod.i32.add(mod.local.get(KI, i), mod.i32.const(127)), mod.i32.const(23)),
  );
  const body = mod.block(
    null,
    [
      mod.local.set(
        KF,
        mod.f32.nearest(mod.f32.mul(mod.local.get(X, f), mod.f32.const(1 / MATH_LN2))),
      ),
      mod.local.set(KI, mod.i32.trunc_s_sat.f32(mod.local.get(KF, f))),
      mod.local.set(
        R,
        mod.f32.sub(
          mod.local.get(X, f),
          mod.f32.mul(mod.local.get(KF, f), mod.f32.const(MATH_LN2)),
        ),
      ),
      // k outside the f32 exponent range = clamp overflow → +Inf / underflow → 0.
      // select is eager, but the garbage twoK·poly is simply discarded out of range.
      mod.select(
        mod.i32.gt_s(mod.local.get(KI, i), mod.i32.const(127)),
        mod.f32.const(Number.POSITIVE_INFINITY),
        mod.select(
          mod.i32.lt_s(mod.local.get(KI, i), mod.i32.const(-126)),
          mod.f32.const(0),
          mod.f32.mul(twoK, poly),
        ),
      ),
    ],
    f,
  );
  mod.addFunction(`${MATH_FN_PREFIX}exp`, binaryen.f32, binaryen.f32, [f, f, i], body);
}

/**
 * `$unworklet_log`: x = m·2^e (= e is the f32 exponent bits, m∈[1,2) is obtained
 * by reinterpreting the mantissa bits with the exponent pinned to 127).
 * log(x) = e·ln2 + log(m), where log(m) is the atanh series of t=(m-1)/(m+1):
 * 2·(t + t³/3 + t⁵/5 + t⁷/7) (= t∈[0,1/3], error ~3e-6). Out-of-domain / special
 * values conform to `Math.log` via select (= x<0 → NaN, x==0 → -Inf, NaN → NaN,
 * +Inf → +Inf), non-trapping. A subnormal input is normalized into the normal
 * range by ×2^24 before bit decomposition, and the result is corrected by 24·ln2
 * (= avoids the breakdown when exponent field=0).
 * locals: 0=x(param) / 1=bits(i32) / 2=m / 3=t / 4=s(=t²) / 5=xn(normalized input).
 */
function buildLogFn(mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const f = binaryen.f32;
  const i = binaryen.i32;
  const X = 0;
  const BITS = 1;
  const M = 2;
  const T = 3;
  const S = 4;
  const XN = 5;
  // Smallest normal f32 = 2^-126. Below this (= subnormal, exponent field=0),
  // naive bit decomposition breaks down, so scale by 2^24 to push into the normal
  // range, decompose, and correct the log result by subtracting 24·ln2 (every
  // subnormal lands in the normal range under ×2^24: the smallest value
  // 2^-149·2^24 = 2^-125).
  const FLT_MIN_NORMAL = 2 ** -126;
  const SUBNORMAL_SCALE = 2 ** 24;
  const SUBNORMAL_LOG_OFFSET = 24 * MATH_LN2;
  const isSubnormal = (): number => mod.f32.lt(mod.local.get(X, f), mod.f32.const(FLT_MIN_NORMAL));
  const s = (): number => mod.local.get(S, f);
  // log(m) polynomial: poly_t = 1 + s·(1/3 + s·(1/5 + s·(1/7))), log(m) = 2·t·poly_t
  let polyT = mod.f32.add(mod.f32.const(1 / 5), mod.f32.mul(s(), mod.f32.const(1 / 7)));
  polyT = mod.f32.add(mod.f32.const(1 / 3), mod.f32.mul(s(), polyT));
  polyT = mod.f32.add(mod.f32.const(1), mod.f32.mul(s(), polyT));
  const logM = mod.f32.mul(mod.f32.mul(mod.f32.const(2), mod.local.get(T, f)), polyT);
  // e = ((bits >> 23) & 0xFF) - 127
  const eF = mod.f32.convert_s.i32(
    mod.i32.sub(
      mod.i32.and(mod.i32.shr_u(mod.local.get(BITS, i), mod.i32.const(23)), mod.i32.const(0xff)),
      mod.i32.const(127),
    ),
  );
  // The ×2^24 scaling of a subnormal makes eF come out 24 too large, so subtract 24·ln2 to undo it.
  const computed = mod.f32.sub(
    mod.f32.add(mod.f32.mul(eF, mod.f32.const(MATH_LN2)), logM),
    mod.select(isSubnormal(), mod.f32.const(SUBNORMAL_LOG_OFFSET), mod.f32.const(0)),
  );
  const body = mod.block(
    null,
    [
      // xn = x · (subnormal ? 2^24 : 1). The subsequent bit decomposition operates on xn.
      mod.local.set(
        XN,
        mod.f32.mul(
          mod.local.get(X, f),
          mod.select(isSubnormal(), mod.f32.const(SUBNORMAL_SCALE), mod.f32.const(1)),
        ),
      ),
      mod.local.set(BITS, mod.i32.reinterpret(mod.local.get(XN, f))),
      // m = reinterpret((bits & 0x007FFFFF) | 0x3F800000) ∈ [1, 2)
      mod.local.set(
        M,
        mod.f32.reinterpret(
          mod.i32.or(
            mod.i32.and(mod.local.get(BITS, i), mod.i32.const(0x7fffff)),
            mod.i32.const(0x3f800000),
          ),
        ),
      ),
      mod.local.set(
        T,
        mod.f32.div(
          mod.f32.sub(mod.local.get(M, f), mod.f32.const(1)),
          mod.f32.add(mod.local.get(M, f), mod.f32.const(1)),
        ),
      ),
      mod.local.set(S, mod.f32.mul(mod.local.get(T, f), mod.local.get(T, f))),
      mod.select(
        mod.f32.gt(mod.local.get(X, f), mod.f32.const(0)),
        // x>0 branch: bit-decomposing +Inf would turn it into a finite value near
        // 128·ln2 (m=1·2^128), so catch it first and keep +Inf. Only finite
        // positive values go through the approximation.
        mod.select(
          mod.f32.eq(mod.local.get(X, f), mod.f32.const(Number.POSITIVE_INFINITY)),
          mod.f32.const(Number.POSITIVE_INFINITY),
          computed,
        ),
        // x<=0 / NaN branch: only x==0 gives -Inf, everything else (= negative /
        // NaN) gives NaN. NaN makes both gt and eq(0) false, so it naturally falls
        // to the NaN side.
        mod.select(
          mod.f32.eq(mod.local.get(X, f), mod.f32.const(0)),
          mod.f32.const(Number.NEGATIVE_INFINITY),
          mod.f32.const(Number.NaN),
        ),
      ),
    ],
    f,
  );
  mod.addFunction(`${MATH_FN_PREFIX}log`, binaryen.f32, binaryen.f32, [i, f, f, f, f], body);
}

/**
 * `$unworklet_tanh`: tanh(x) = 1 - 2/(exp(2x)+1), delegating to the exp function.
 * Because the numerator is finite (= 2), large inputs do not produce Inf/Inf and
 * instead saturate to ±1. exp's relative error shrinks to ≤ 1.2e-6 for tanh.
 * No locals (= x is the param).
 */
function buildTanhFn(mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const f = binaryen.f32;
  const e2x = mod.call(
    `${MATH_FN_PREFIX}exp`,
    [mod.f32.mul(mod.f32.const(2), mod.local.get(0, f))],
    binaryen.f32,
  );
  const body = mod.f32.sub(
    mod.f32.const(1),
    mod.f32.div(mod.f32.const(2), mod.f32.add(e2x, mod.f32.const(1))),
  );
  mod.addFunction(`${MATH_FN_PREFIX}tanh`, binaryen.f32, binaryen.f32, [], body);
}
