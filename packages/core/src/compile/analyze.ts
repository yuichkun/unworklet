/**
 * Static-analysis stage of the compile pipeline (= `03-compiler.md` §3, the
 * first of the plan Q-D per-stage internal modules).
 *
 * Layer 3 checks are filled in per kind. Currently implemented:
 *   - `constant-truthy-emitif` (Q32-c): an `emitIf` cond that is syntactically
 *     constant-truthy inside a `forSample` callback is rejected before emit.
 *   - `select-branch-type-mismatch`: the two branches of a `select` have
 *     different scalar types — WASM `select` requires same-type branches, so
 *     this is rejected. Even after polymorphic lowering, a branch type mismatch
 *     (= one that slipped past TS) is caught fail-loud.
 *
 * Arithmetic / comparison carry the operands' scalar type on the AST, and emit
 * issues type-specific instructions (= polymorphic lowering). The former
 * `non-f32-arithmetic` guard (= which prevented silent mis-compilation back when
 * emit was fixed to f32) has been removed.
 */

import type { AstNode, CapturedGraph } from "./ast.ts";
import { inferAstType } from "./ast.ts";
import { SIMD_LANE_COUNT } from "../dsl/constants.ts";
import { SYSEX_PER_CHUNK_BYTES } from "./layout.ts";

export type DiagnosticEntry = {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
};

/**
 * Whether the cond AST represents a build-time-constant truthy value. Paired
 * with the literal lift done at graph-capture time, it treats a literal with
 * value !== 0 as truthy.
 */
function isConstantTruthy(node: AstNode): boolean {
  return node.kind === "literal" && node.value !== 0;
}

function walkForConstantTruthyEmitIf(
  body: readonly AstNode[],
  diagnostics: DiagnosticEntry[],
): void {
  for (const node of body) {
    if (node.kind === "eventEmitIf" && isConstantTruthy(node.cond)) {
      diagnostics.push({
        id: "constant-truthy-emitif",
        severity: "error",
        message: `unworklet: event "${node.name}" emitIf has a constant-truthy cond inside forSample — unconditional emission at audio rate fills the ringbuffer in milliseconds. Use a state-edge gated cond, move the emission to a handler context, or wrap it in everyNSamples(N, ...) for sub-rate periodic emission (= Q32-c, stable ID 'constant-truthy-emitif')`,
      });
    }
    // MIDI emit shares the same ring (= `11-midi.md` §4): an `emitIf(true)` at
    // sample rate saturates the MIDI ringbuffer just as `event` does.
    if (node.kind === "midiEmitIf" && isConstantTruthy(node.cond)) {
      diagnostics.push({
        id: "constant-truthy-emitif",
        severity: "error",
        message: `unworklet: midi port "${node.port}" emitIf has a constant-truthy cond inside forSample — unconditional emission at audio rate fills the ringbuffer in milliseconds. Use a state-edge gated cond, move the emission to a handler context, or wrap it in everyNSamples(N, ...) for sub-rate periodic emission (= Q32-c, stable ID 'constant-truthy-emitif')`,
      });
    }
    if (node.kind === "forSample") {
      walkForConstantTruthyEmitIf(node.body, diagnostics);
    }
  }
}

/**
 * Walks every node and detects branch type mismatches in `select`
 * (= `select-branch-type-mismatch`). Literal branches are already lifted to the
 * branch type by the select builder (= Q33); what is caught here is a genuine
 * type mismatch that slipped past TS (e.g. a `Node<'f32'>` and a `Node<'i32'>`
 * as the two branches).
 */
function walkForTypeErrors(node: AstNode, diagnostics: DiagnosticEntry[]): void {
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
    case "and":
    case "or":
      walkForTypeErrors(node.lhs, diagnostics);
      walkForTypeErrors(node.rhs, diagnostics);
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
    case "exp":
    case "log":
    case "tanh":
    case "convert":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "clamp":
      walkForTypeErrors(node.x, diagnostics);
      walkForTypeErrors(node.lo, diagnostics);
      walkForTypeErrors(node.hi, diagnostics);
      break;
    case "select": {
      const thenType = inferAstType(node.ifTrue);
      const elseType = inferAstType(node.ifFalse);
      if (thenType !== elseType) {
        diagnostics.push({
          id: "select-branch-type-mismatch",
          severity: "error",
          message: `unworklet: select branches have mismatched scalar types ('${thenType}' vs '${elseType}') — WASM select requires both branches to be the same type. (stable ID 'select-branch-type-mismatch')`,
        });
      }
      walkForTypeErrors(node.cond, diagnostics);
      walkForTypeErrors(node.ifTrue, diagnostics);
      walkForTypeErrors(node.ifFalse, diagnostics);
      break;
    }
    case "audioInRead":
    case "paramAt":
      walkForTypeErrors(node.offset, diagnostics);
      break;
    case "audioOutWrite":
      walkForTypeErrors(node.offset, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "stateStore":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "bufferRead":
      walkForTypeErrors(node.index, diagnostics);
      break;
    case "bufferReadInterpolated":
      walkForTypeErrors(node.pos, diagnostics);
      break;
    case "payloadFieldRead":
      walkForTypeErrors(node.index, diagnostics);
      break;
    case "payloadFieldLength":
      break;
    case "bufferCopyFrom":
      // No child expressions (= bufferName / messageName / field are strings).
      break;
    case "bufferWrite":
      walkForTypeErrors(node.index, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "forSample":
    case "messageOnReceive":
    case "everyNSamples":
    case "midiOnEvent":
      for (const child of node.body) walkForTypeErrors(child, diagnostics);
      break;
    case "eventEmitIf":
      walkForTypeErrors(node.cond, diagnostics);
      walkForTypeErrors(node.atSample, diagnostics);
      for (const field of node.fields) {
        walkForTypeErrors(field.value, diagnostics);
        if (field.length !== undefined) walkForTypeErrors(field.length, diagnostics);
      }
      break;
    case "vecConst":
      for (const l of node.lanes) walkForTypeErrors(l, diagnostics);
      break;
    case "vecSplat":
    case "vecLane":
    case "vecSumLanes":
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "vecAdd":
    case "vecSub":
    case "vecMul":
    case "vecDiv":
      walkForTypeErrors(node.lhs, diagnostics);
      walkForTypeErrors(node.rhs, diagnostics);
      break;
    case "bufferLoadVec":
      walkForTypeErrors(node.offset, diagnostics);
      break;
    case "bufferStoreVec":
      walkForTypeErrors(node.offset, diagnostics);
      walkForTypeErrors(node.value, diagnostics);
      break;
    case "literal":
    case "loopCounter":
    case "stateLoad":
    case "messageFieldRead":
    case "noiseSourceNext":
      break;
  }
}

// The strides allowed for forSample.byN(stride) = powers of two that evenly
// divide one block (128). Cases like SIMD bulk (a 4-sample load at stride 4)
// require 128 / stride to be an integer.
const ALLOWED_STRIDES = new Set([1, 2, 4, 8, 16, 32, 64, 128]);

// Compile-time static validation of the loop primitives (forSample.byN /
// everyNSamples). The forSample.byN stride must be a power of two that divides
// 128 (= ALLOWED_STRIDES); per §9.5 the everyNSamples divisor N must be a
// "compile-time positive integer" (= because the counter free-runs across
// blocks it need not divide 128, §9.1). Either violation is rejected before it
// reaches the audio thread: with N=0, emit would emit i32.rem_u(counter, 0),
// which traps on a divide-by-zero on the audio thread.
function walkForLoopErrors(body: readonly AstNode[], diagnostics: DiagnosticEntry[]): void {
  for (const node of body) {
    if (node.kind === "forSample") {
      if (!ALLOWED_STRIDES.has(node.stride)) {
        diagnostics.push({
          id: "illegal-stride",
          severity: "error",
          message: `unworklet: forSample.byN stride ${node.stride} is not a power of two that evenly divides the render quantum (128). Allowed: 1, 2, 4, 8, 16, 32, 64, 128 (stable ID 'illegal-stride')`,
        });
      }
      walkForLoopErrors(node.body, diagnostics);
    } else if (node.kind === "everyNSamples") {
      if (!Number.isInteger(node.divisor) || node.divisor < 1) {
        diagnostics.push({
          id: "illegal-everyn-divisor",
          severity: "error",
          message: `unworklet: everyNSamples(N) requires N to be a compile-time positive integer (got ${node.divisor}). N=0 traps on a divide-by-zero on the audio thread; negative or non-integer values are invalid (stable ID 'illegal-everyn-divisor')`,
        });
      }
      walkForLoopErrors(node.body, diagnostics);
    }
  }
}

// §5.1: a message<T> / event<T> payload may have at most one variable-length
// (typed-array) field. A slot can only hold a single [payloadLen, payloadOffset]
// pair, so more than one breaks the transport → graph-capture-time error. A
// field's payloadElementType is sealed on access (.at() / copyFrom / emitIf), so
// count the sealed ones and reject at two or more.
function checkPayloadFieldLimit(graph: CapturedGraph, diagnostics: DiagnosticEntry[]): void {
  for (const decl of graph.declarations) {
    if (decl.kind !== "message" && decl.kind !== "event") continue;
    const taFields = decl.fields.filter((f) => f.payloadElementType !== undefined);
    if (taFields.length > 1) {
      diagnostics.push({
        id: "multiple-typed-array-fields",
        severity: "error",
        message:
          `unworklet: ${decl.kind} "${decl.name}" payload has ${taFields.length} variable-length ` +
          `(typed-array) fields (${taFields.map((f) => f.name).join(", ")}). v1.0.0 allows at most ` +
          `one variable-length field per payload (§5.1). (stable ID 'multiple-typed-array-fields')`,
      });
    }
  }
}

/** 64 MiB — low-end-device load-time concern (warning). */
const MEMORY_WARN_BYTES = 64 * 1024 * 1024;
/** 4 GiB — the WASM 32-bit linear-memory ceiling (hard error). */
const MEMORY_ERROR_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Memory-budget check (Q30, `03-compiler.md` §2.6 stable ID `memory-budget`).
 * The compiler auto-sums every declaration into a single linear-memory
 * allocation; `memory.grow` on the audio thread is permanently excluded. A
 * total above 64 MiB emits a build-time warning (load-time concern), above the
 * 4 GiB WASM32 ceiling a hard error. Takes the laid-out `totalBytes` since the
 * sum is only known after `layout`.
 */
export function checkMemoryBudget(totalBytes: number): DiagnosticEntry[] {
  if (totalBytes > MEMORY_ERROR_BYTES) {
    return [
      {
        id: "memory-budget",
        severity: "error",
        message:
          `unworklet: declaration memory sum (${totalBytes} bytes) exceeds the WASM 32-bit ` +
          `linear-memory ceiling of 4 GiB. Reduce buffer sizes or move large content to a ` +
          `message<T> upload pattern. (stable ID 'memory-budget')`,
      },
    ];
  }
  if (totalBytes > MEMORY_WARN_BYTES) {
    return [
      {
        id: "memory-budget",
        severity: "warning",
        message:
          `unworklet: declaration memory sum (${totalBytes} bytes) exceeds 64 MiB — this loads ` +
          `slowly on low-end devices. Consider reducing buffer sizes. (stable ID 'memory-budget')`,
      },
    ];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// handler-field-escape: a `message<T>` onReceive payload field (or a MIDI
// onEvent field) decodes the *current drain slot* and is only valid inside the
// handler body that drains it. Capturing such a field Node and reading it
// elsewhere (a forSample, the per-block top level, another handler) makes emit
// read an unset slot pointer = a silent 0 / garbage value. Detect statically.
// ─────────────────────────────────────────────────────────────────────────

type HandlerScope = { kind: "message"; name: string } | { kind: "midi"; port?: string } | null;

// Every AstNode-valued child field except `body` (bodies carry handler scope and
// are walked explicitly). Field-name based, so a new node kind is covered without
// re-listing variants; a missed field only weakens detection, never flags valid code.
const EXPR_CHILD_FIELDS = [
  "lhs",
  "rhs",
  "value",
  "x",
  "lo",
  "hi",
  "cond",
  "ifTrue",
  "ifFalse",
  "offset",
  "index",
  "pos",
  "atSample",
  "channel",
  "arg1",
  "arg2",
  "sysexLength",
] as const;

function exprChildren(node: AstNode): AstNode[] {
  const n = node as Record<string, unknown>;
  const out: AstNode[] = [];
  const push = (v: unknown): void => {
    if (v !== null && typeof v === "object" && "kind" in v) out.push(v as AstNode);
  };
  for (const f of EXPR_CHILD_FIELDS) push(n[f]);
  if (Array.isArray(n["lanes"])) for (const l of n["lanes"]) push(l);
  if (Array.isArray(n["fields"])) {
    for (const field of n["fields"] as Array<Record<string, unknown>>) {
      push(field["value"]);
      push(field["length"]);
    }
  }
  return out;
}

function checkHandlerFieldEscape(
  node: AstNode,
  scope: HandlerScope,
  diagnostics: DiagnosticEntry[],
): void {
  let want: "message" | "midi";
  let wantName: string | undefined;
  let label: string;
  switch (node.kind) {
    case "messageFieldRead":
      want = "message";
      wantName = node.name;
      label = `message "${node.name}" field "${node.field}"`;
      break;
    case "payloadFieldRead":
    case "payloadFieldLength":
      want = "message";
      wantName = node.messageName;
      label = `message "${node.messageName}" field "${node.field}"`;
      break;
    case "bufferCopyFrom":
      want = "message";
      wantName = node.messageName;
      label = `message "${node.messageName}" field "${node.field}"`;
      break;
    case "midiFieldRead":
      want = "midi";
      wantName = undefined;
      label = `midi field "${node.field}"`;
      break;
    case "midiSysexLength":
    case "midiSysexCopy":
      want = "midi";
      wantName = node.port;
      label = `midi port "${node.port}" sysex`;
      break;
    default:
      return;
  }
  const ok =
    want === "midi"
      ? scope !== null &&
        scope.kind === "midi" &&
        (wantName === undefined || scope.port === wantName)
      : scope !== null && scope.kind === "message" && scope.name === wantName;
  if (!ok) {
    diagnostics.push({
      id: "handler-field-escape",
      severity: "error",
      message:
        `unworklet: ${label} is read outside its handler. Handler payload fields decode the ` +
        `current drain slot and are only valid inside the on-receive / on-event body — a field ` +
        `Node captured and read elsewhere reads an unset slot (= silent 0). Move the read into ` +
        `the handler, or copy the value into a state / buffer first. (stable ID 'handler-field-escape')`,
    });
  }
}

function walkHandlerFieldEscape(
  nodes: readonly AstNode[],
  scope: HandlerScope,
  diagnostics: DiagnosticEntry[],
): void {
  for (const node of nodes) {
    checkHandlerFieldEscape(node, scope, diagnostics);
    walkHandlerFieldEscape(exprChildren(node), scope, diagnostics);
    if (node.kind === "messageOnReceive") {
      walkHandlerFieldEscape(node.body, { kind: "message", name: node.name }, diagnostics);
    } else if (node.kind === "midiOnEvent") {
      walkHandlerFieldEscape(node.body, { kind: "midi", port: node.port }, diagnostics);
    } else if (node.kind === "forSample" || node.kind === "everyNSamples") {
      walkHandlerFieldEscape(node.body, scope, diagnostics);
    }
  }
}

/**
 * A sysex emit's source `buffer.u8` must fit inside one content chunk
 * (`SYSEX_PER_CHUNK_BYTES - 4` payload bytes). A bigger buffer could never
 * ship whole, and truncating at emit would deliver a corrupt sysex (no 0xF7
 * terminator) — so the mismatch is a build error, not a runtime surprise.
 * Recurses into handler / loop bodies (the echo shape emits inside a
 * `midiOnEvent` handler).
 */
function walkSysexBufferFit(
  graph: CapturedGraph,
  body: readonly AstNode[],
  diagnostics: DiagnosticEntry[],
): void {
  const maxBody = SYSEX_PER_CHUNK_BYTES - 4;
  for (const node of body) {
    if (
      node.kind === "midiEmitIf" &&
      node.eventType === "sysex" &&
      node.sysexBufferName !== undefined
    ) {
      const decl = graph.declarations.find(
        (d) => d.kind === "buffer" && d.name === node.sysexBufferName,
      );
      if (decl !== undefined && decl.kind === "buffer" && decl.size > maxBody) {
        diagnostics.push({
          id: "sysex-buffer-exceeds-chunk",
          severity: "error",
          message: `unworklet: midi port "${node.port}" emits sysex from buffer "${node.sysexBufferName}" (${decl.size} bytes), which exceeds the ${maxBody}-byte sysex content chunk — the message could never ship whole, and truncating would drop the 0xF7 terminator. Use a buffer of <= ${maxBody} bytes, or split the transfer. (stable ID 'sysex-buffer-exceeds-chunk')`,
        });
      }
    }
    if (
      node.kind === "forSample" ||
      node.kind === "everyNSamples" ||
      node.kind === "messageOnReceive" ||
      node.kind === "midiOnEvent"
    ) {
      walkSysexBufferFit(graph, node.body, diagnostics);
    }
  }
}

/**
 * SIMD buffer-window backstop (issue: undersized `loadVec` / `storeVec`): a
 * lane window spans `SIMD_LANE_COUNT` elements, so a buffer holding fewer has
 * no in-bounds offset — the emitted index clamp saturates into an empty range
 * and the 16-byte access still crosses into the next memory region. The buffer
 * factories reject this at capture; a hand-built graph bypasses them.
 */
function walkVecBufferFit(
  graph: CapturedGraph,
  body: readonly AstNode[],
  diagnostics: DiagnosticEntry[],
): void {
  const undersized = new Set(
    graph.declarations
      .filter((d) => d.kind === "buffer" && d.size < SIMD_LANE_COUNT)
      .map((d) => d.name),
  );
  if (undersized.size === 0) return;
  const seen = new Set<string>();
  const visit = (node: AstNode): void => {
    if (
      (node.kind === "bufferLoadVec" || node.kind === "bufferStoreVec") &&
      undersized.has(node.name) &&
      !seen.has(node.name)
    ) {
      seen.add(node.name);
      const decl = graph.declarations.find((d) => d.kind === "buffer" && d.name === node.name);
      const size = decl !== undefined && decl.kind === "buffer" ? decl.size : 0;
      diagnostics.push({
        id: "simd-buffer-too-small",
        severity: "error",
        message: `unworklet: buffer "${node.name}" is used with a SIMD lane op but holds ${size} element(s) — a ${SIMD_LANE_COUNT}-lane access reads/writes ${SIMD_LANE_COUNT * 4} bytes and no offset keeps that inside the buffer. Declare it with size >= ${SIMD_LANE_COUNT}, or use read() / write(). (stable ID 'simd-buffer-too-small')`,
      });
    }
    for (const child of exprChildren(node)) visit(child);
    if (
      node.kind === "forSample" ||
      node.kind === "everyNSamples" ||
      node.kind === "messageOnReceive" ||
      node.kind === "midiOnEvent"
    ) {
      for (const child of node.body) visit(child);
    }
  };
  for (const node of body) visit(node);
}

export function analyze(graph: CapturedGraph): DiagnosticEntry[] {
  const diagnostics: DiagnosticEntry[] = [];
  // Buffer publish backstop (issue #38): the declaration factories throw at
  // capture, but a hand-built graph bypasses them. The publish pipeline is
  // scalar-only — a published buffer never appears on `node.state` — so reject
  // rather than compile a declaration whose runtime surface does not exist.
  for (const decl of graph.declarations) {
    if (decl.kind === "buffer" && decl.publish !== undefined) {
      diagnostics.push({
        id: "buffer-publish-unsupported",
        severity: "error",
        message: `unworklet: buffer "${decl.name}" declares publish, but buffer publish is not wired to the main thread — the slot would never appear on node.state. Fan the values out into scalar state slots, or read the buffer back via node.snapshot(). (stable ID 'buffer-publish-unsupported')`,
      });
    }
  }
  walkForLoopErrors(graph.statements, diagnostics);
  checkPayloadFieldLimit(graph, diagnostics);
  walkSysexBufferFit(graph, graph.statements, diagnostics);
  walkVecBufferFit(graph, graph.statements, diagnostics);
  walkHandlerFieldEscape(graph.statements, null, diagnostics);
  for (const stmt of graph.statements) {
    if (stmt.kind === "forSample") {
      walkForConstantTruthyEmitIf(stmt.body, diagnostics);
    }
    walkForTypeErrors(stmt, diagnostics);
  }
  return diagnostics;
}
