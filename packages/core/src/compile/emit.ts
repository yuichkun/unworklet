/**
 * WASM emission stage of the compile pipeline (= plan Q-F 引 数 ナ シ +
 * 固 定 region WASM export、 plan Q-D stage 別 internal module の 1 つ)。
 *
 * binaryen を dynamic import (= `09-repo-structure.md` §2.4 invariant、
 * static path consumer の production runtime bundle に は 含 ま な い) し て
 * AST → binaryen IR lower。 出 力 = WASM binary (= Uint8Array)。
 *
 * WASM の linear memory は `layout.totalBytes` を 64 KB page で 切 り 上 げ た
 * size を min == max で pre-allocate (= `memory.grow` 永 久 排 除、
 * `00-foundations.md` §5.1 invariant)。 export = `process` (= 引 数 ナ シ、
 * Q-F) + `memory` (= host が 固 定 offset で 入 出 力 marshal)。
 *
 * forSample = bounded loop (= Phase 1 step-1.7 path 移 植) で stride 単 位 に
 * 増 加、 loopCounter は local 0 を 経 由。 Phase 3 = forSample 1 階 層 想 定
 * (= canonical Ex 1 minus meter)、 nested forSample / forSample.byN 対 応 は
 * 後 続 phase で fill。
 */

import type { AstNode, CapturedGraph } from "./ast.ts";
import type { Layout } from "./layout.ts";

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
 * f32 / f64 用 subnormal guard temp local (= function locals array index 1 / 2)。
 *
 * subnormal guard で `|v| < 1e-30 ? 0 : v` を 構 築 す る 時、 v を `abs / lt` の
 * condition と `select` の else 側 で 2 度 参 照 す る 必要。 ナイーブ に
 * `emitExpression(valueNode, ...)` を 2 度 呼 ぶ と、 v が 「audioInRead 経 由 +
 * forSample 後 の 文 脈」 で binaryen 内 部 で 共 有 / 不 正 expression 生 成 path
 * に 入 り NaN を 生 む (= 実 測 確 認)。 `local.tee` で 1 度 だ け 評 価 + local に
 * 保 存 + 値 を 渡 し、 もう 1 度 必 要 な ら `local.get` で 再 取 得 す る 形 が
 * 標 準 path = 重 複 evaluation ナ シ + binaryen 内 部 共 有 path も 経 由 し な い。
 */
const SUBNORMAL_F32_LOCAL = 1;
const SUBNORMAL_F64_LOCAL = 2;
/**
 * publish scheduler 用 i32 temp local (= sub-phase 7.3)。 各 publish slot 用
 * の sample counter += 128 後 の 値 を 1 度 だ け 評 価 + threshold check + due path
 * で counter -= threshold で 再 取 得 する path (= 重 複 evaluation 回 避、
 * binaryen 内 部 path の 罠 回 避 = subnormal guard と 同 軸)。
 */
const PUBLISH_COUNTER_LOCAL = 3;

/**
 * `event.emitIf` 用 i32 temp local (= sub-phase 7.6 commit 4)。
 *
 * - `EVENT_HEAD_LOCAL` = ring head を 1 度 load し て overflow check + slot offset
 *   計 算 + head += 1 store で 再 取 得 (= 重 複 evaluation ナ シ)。
 * - `EVENT_SLOT_PTR_LOCAL` = slot pointer (= base + 12 + (head % capacity) ×
 *   slotSize) を 1 度 計 算 し て 各 field store で 再 取 得 (= 重 複 計 算 + binaryen
 *   path の 罠 回 避)。
 */
const EVENT_HEAD_LOCAL = 4;
const EVENT_SLOT_PTR_LOCAL = 5;
/**
 * `message.onReceive` drain 用 i32 temp local (= sub-phase 7.7c)。
 * - `MESSAGE_TAIL_LOCAL` = ring tail を 1 度 load + drain loop 内 で += 1
 *   進 め + drain 末 尾 で SAB に commit。
 * EVENT_HEAD_LOCAL / EVENT_SLOT_PTR_LOCAL は message ring drain で 共 用
 * (= forSample / event emit と message drain は 同 process 内 で 排 他 実 行 =
 *   local lifetime 衝 突 ナ シ)。
 */
const MESSAGE_TAIL_LOCAL = 6;

/**
 * Subnormal flush threshold (= Q21、 `04-worklet-runtime.md` §6)。
 * `state.f32` / `state.f64` の `.store(v)` で `|v| < 1e-30` を 0 に 落 と し て
 * IIR feedback path で の CPU spike を 撤 廃。 threshold 1e-30 は
 * IEEE 754 binary32 subnormal 範 囲 (≈ 1.18e-38 以 下) を 含 む 単 純
 * boundary、 normal 範 囲 末 端 も 同 時 flush だ が audio 出 力 と し て
 * 不 可 聴 = 1 値 fix。
 */
const SUBNORMAL_THRESHOLD = 1e-30;

/**
 * `emit` options (= sub-phase 7.3 で 追 加)。 sampleRate を build-time const
 * と し て publish scheduler の threshold = `Math.round(sampleRate / rateFps)`
 * に const fold す る。 default = 48000 (= 既 fixture / host 既 定 と zip)。
 */
export type EmitOptions = {
  sampleRate?: number;
};

const DEFAULT_EMIT_SAMPLE_RATE = 48000;

export async function emit(
  graph: CapturedGraph,
  layout: Layout,
  options: EmitOptions = {},
): Promise<Uint8Array> {
  const sampleRate = options.sampleRate ?? DEFAULT_EMIT_SAMPLE_RATE;
  const binaryen = (await import("binaryen")).default;
  const mod = new binaryen.Module();

  const pages = Math.max(1, Math.ceil(layout.totalBytes / PAGE_BYTES));
  mod.setMemory(pages, pages, "memory");

  // Q38-b 規 範: 全 onReceive handler は per-block top / forSample よ り 先 に drain。
  // source order と zip し な い = framework が 「messageOnReceive 集 め て 先 emit
  // + 他 statements 後 emit」 で 並 び 替 え (= docs `01-dsl.md` §4.2 + §1 規 定)。
  // 同 message の 複 数 onReceive registration は 1 つ の drain loop に 集 約 +
  // 各 slot で 全 registration body を registration order で 連 続 fire (= Q38-c)。
  const onReceiveByMessage = new Map<string, AstNode[]>();
  const otherStmts: AstNode[] = [];
  for (const s of graph.statements) {
    if (s.kind === "messageOnReceive") {
      const merged = onReceiveByMessage.get(s.name) ?? [];
      merged.push(...s.body);
      onReceiveByMessage.set(s.name, merged);
    } else {
      otherStmts.push(s);
    }
  }
  const onReceiveEmits = [...onReceiveByMessage.entries()].map(([name, body]) =>
    emitMessageOnReceive({ kind: "messageOnReceive", name, body }, layout, mod, binaryen),
  );
  const otherEmits = otherStmts.map((s) => emitStatement(s, layout, mod, binaryen));
  const schedulerBlocks = emitPublishScheduler(graph, layout, sampleRate, mod, binaryen);
  const body = mod.block(null, [...onReceiveEmits, ...otherEmits, ...schedulerBlocks]);

  // function locals = [i32 loop counter, f32 subnormal guard temp, f64 subnormal guard temp,
  //                    i32 publish counter temp, i32 event head temp, i32 event/message slot ptr temp,
  //                    i32 message tail temp]。
  // event emit が head / slot ptr を 1 度 だ け 評 価 + 各 field store で 再 取 得、
  // message drain が tail を 1 度 load + drain loop で 進 め + commit。
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
    ],
    body,
  );
  mod.addFunctionExport("process", "process");

  const wasm = mod.emitBinary();
  mod.dispose();
  return wasm;
}

/**
 * publish scheduler emit (= sub-phase 7.3、 `04-worklet-runtime.md` §7)。
 *
 * 各 publish flag 持 つ state slot ご と に process function 末 尾 に inline:
 * 1. local PUBLISH_COUNTER_LOCAL = `i32.load(counterOffset) + SAMPLES_PER_BLOCK`
 * 2. if local >= threshold:
 *    - publishShared に state 値 を copy (= type 別 load + store)
 *    - i32.store(versionOffset, i32.load(versionOffset) + 1)
 *    - i32.store(counterOffset, local - threshold)  (= 残 り を carry)
 *    else:
 *    - i32.store(counterOffset, local)
 *
 * threshold = `Math.round(sampleRate / rateFps)` = build-time const fold。
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
    /* v8 ignore next 3 — publish 持 つ state slot は layout で 既 push 済 path =
       unreachable defensive guard */
    if (stateOffset === undefined || sharedOffset === undefined || counterOffset === undefined) {
      throw new Error(`unknown publish slot: ${decl.name}`);
    }
    const versionOffset = counterOffset + 4;
    const threshold = Math.round(sampleRate / decl.publish.rateFps);

    // type 別 load / store (= publish flag 持 つ type は Q42 で f32 / i32 / bool 制 限)
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

export function emitExpression(
  node: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  switch (node.kind) {
    case "literal":
      // sub-phase 7.1 で f64 literal 対 応 を 追 加 (= state.f64 subnormal guard
      // test で 1e-40 等 の 値 を 直 接 渡 す path)。 i64 / bool literal は
      // ast.ts の literal `value: number` 制 約 下 で 表 現 不 完 全 (= i64 は
      // BigInt 必 要 + bool は boolean が 自 然) = 後 続 sub-phase で literal
      // 型 拡 張 と zip し て fill。 当 phase で は state.i64 / state.bool は
      // 別 path (= stateLoad / 既 memory 値) で 駆 動 す る。
      switch (node.type) {
        case "f32":
          return mod.f32.const(node.value);
        case "f64":
          return mod.f64.const(node.value);
        case "i32":
          return mod.i32.const(node.value);
        case "i64":
          throw new Error("i64 literal emission not implemented (= 後 続 sub-phase で fill)");
        case "bool":
          throw new Error("bool literal emission not implemented (= 後 続 sub-phase で fill)");
      }
    case "loopCounter":
      return mod.local.get(LOOP_COUNTER_LOCAL, binaryen.i32);
    case "mul":
      return mod.f32.mul(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "add":
      return mod.f32.add(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "sub":
      return mod.f32.sub(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "div":
      return mod.f32.div(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "abs":
      return mod.f32.abs(emitExpression(node.value, layout, mod, binaryen));
    case "neg":
      return mod.f32.neg(emitExpression(node.value, layout, mod, binaryen));
    case "sqrt":
      return mod.f32.sqrt(emitExpression(node.value, layout, mod, binaryen));
    case "floor":
      return mod.f32.floor(emitExpression(node.value, layout, mod, binaryen));
    case "ceil":
      return mod.f32.ceil(emitExpression(node.value, layout, mod, binaryen));
    case "max":
      return mod.f32.max(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "min":
      return mod.f32.min(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
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
          // bool は 内 部 i32 表 現 (= 0 / 1)、 caller 側 で `select` / `lt` 等 で
          // 利 用 す る (= Q42 + sub-phase 7.4 SAB publish path と zip)
          return mod.i32.load(0, BYTES_PER_I32, ptr);
      }
    }
    case "messageFieldRead": {
      // drain loop 内 で MESSAGE_SLOT_PTR (= EVENT_SLOT_PTR_LOCAL 共 用) が
      // 既 set 済 = local.get 経 由 で 取 + field offset 加 算 で memory.load。
      const slot = layout.regions.messageRings.slots[node.name];
      /* v8 ignore next 3 — slot は emitMessageOnReceive で 既 check 済 path =
         unreachable defensive guard */
      if (slot === undefined) {
        throw new Error(`unknown message slot: ${node.name}`);
      }
      const field = slot.fields.find((f) => f.name === node.field);
      /* v8 ignore next 3 — field 名 は capture proxy 経 由 で decl.fields に push 済
         = unreachable defensive guard */
      if (field === undefined) {
        throw new Error(`unknown message field: ${node.name}.${node.field}`);
      }
      const ptr = mod.i32.add(
        mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32),
        mod.i32.const(field.offsetInSlot),
      );
      // Q46 uniform lift で sub-phase 7.7 段 階 は wireType = i32 / bool の み seal、
      // f32 / f64 / i64 は typed-array path と zip し て 後 続 sub-phase で fill。
      if (field.wireType === "i32" || field.wireType === "bool") {
        return mod.i32.load(0, BYTES_PER_I32, ptr);
      }
      /* v8 ignore next 3 — Q46 uniform lift path で wireType = i32 / bool だ け
         seal = unreachable defensive guard */
      throw new Error(
        `unworklet: unsupported message field wireType "${field.wireType}" (= sub-phase 7.7 段 階 で i32 / bool の み 対 応)`,
      );
    }
    case "audioOutWrite":
    case "forSample":
    case "stateStore":
    case "eventEmitIf":
    case "messageOnReceive":
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
          // bool は 内 部 i32 表 現 (= store も i32.store、 subnormal guard ナ シ)
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
      const loopBody = node.body.map((s) => emitStatement(s, layout, mod, binaryen));
      return mod.block(null, [
        mod.local.set(LOOP_COUNTER_LOCAL, mod.i32.const(0)),
        mod.block("break", [
          mod.loop(
            "continue",
            mod.block(null, [
              mod.br_if(
                "break",
                mod.i32.ge_s(mod.local.get(LOOP_COUNTER_LOCAL, binaryen.i32), mod.i32.const(128)),
              ),
              ...loopBody,
              mod.local.set(
                LOOP_COUNTER_LOCAL,
                mod.i32.add(
                  mod.local.get(LOOP_COUNTER_LOCAL, binaryen.i32),
                  mod.i32.const(node.stride),
                ),
              ),
              mod.br("continue"),
            ]),
          ),
        ]),
      ]);
    }
    case "eventEmitIf":
      return emitEventEmitIf(node, layout, mod, binaryen);
    /* v8 ignore next 2 — messageOnReceive は emit top-level で 並 び 替 え 経 由 で
       emitMessageOnReceive を 直 接 呼 ぶ path = emitStatement 経 由 hit ナ シ */
    case "messageOnReceive":
      return emitMessageOnReceive(node, layout, mod, binaryen);
    default:
      throw new Error(`expression node '${node.kind}' cannot appear in statement position`);
  }
}

/**
 * Subnormal guard emit (= `|v| < 1e-30 ? 0 : v` の WASM IR、 Q21)。
 * f32 / f64 の `state.store(v)` で 自 動 inline。
 *
 * `block(name, [local.set(v), expression_using_local.get], type)` 形 で v を
 * 1 度 だ け 評 価 + local に 保 存 し、 後 続 expression で `local.get` を 2 度
 * 参 照 (= 1 度 = abs / lt の condition、 もう 1 度 = select else)。 ナ イー ブ
 * な 「v を 2 度 emit す る」 path は binaryen 内 部 で 「audioInRead 経 由 +
 * forSample 後 の 文 脈」 で NaN を 生 む trigger に な っ た (= 実 測 確 認)、
 * local 経 由 で 1 度 評 価 path に refactor し て 解 消。
 */
function emitSubnormalGuardF32(
  valueNode: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  // WASM `select` は eager evaluation = 全 3 引 数 を 先 に 評 価 し て か ら 選 ぶ。
  // ifFalse 内 の `local.get` が 「`local.tee` よ り 前 に 評 価」 さ れ て local 初 期 値
  // 0 を 取 っ て し ま う 罠 が 発 生 (= 実 測 確 認)。 `if-else` は lazy evaluation =
  // condition 評 価 で `local.tee` が 走 っ て か ら、 then / else の どち ら だ け が
  // 評 価 さ れ る = local が確 実 に v に な っ て か ら else 側 の `local.get` が 走 る。
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
 * `event.emitIf` WASM emit (= sub-phase 7.6 commit 4、 `02-messaging.md` §4 + §5.1)。
 *
 * cond truthy で fire path:
 * 1. head を 1 度 load + `EVENT_HEAD_LOCAL` に hold
 * 2. overflow check (= head + 1 - tail >= capacity) で drop-oldest:
 *    overflowCount += 1 + tail += 1
 * 3. slot ptr = base + 12 + (head % capacity) × slotSize を 1 度 計 算 +
 *    `EVENT_SLOT_PTR_LOCAL` に hold
 * 4. slot に atSample + 各 field を store (= layout.regions.eventRings.slots[name].fields
 *    の per-field offset / wireType に zip)
 * 5. head += 1 を store
 *
 * SAB Atomics は worklet template (= commit 5) で reflect、 こ こ で は 通 常
 * memory.load / store だ け。
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

  // value lookup helper (= AST field value AST → WASM expr)、 layout の field
  // に zip し て emit (= atSample 先 頭 + payload 順)
  const fieldValueByName = new Map<string, AstNode>([
    ["atSample", node.atSample],
    ...node.fields.map((f) => [f.name, f.value] as const),
  ]);

  // overflow check + drop-oldest (= ring full ＝ distance head − tail ≥ capacity
  // で 既 fill 済 ＝ 次 emit が 古 い slot を 上 書 き = drop-oldest)。
  // 案 B 規 範 (= `02-messaging.md` §5.1): user 視 点 で 「capacity ＝ 何 個 fill 可 能 か」
  // を そ の ま ま reflect、 head ・ tail を 単 調 増 加 i32 で 持 つ 形 だ か ら ring
  // buffer 教 科 書 規 範 の 「1 slot 余 計 に 空 け る」 は 不 要。
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

  // slot ptr = slotsBase + (head % capacity) × slotSize、 1 度 計 算 + local hold
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

  // 各 field の store statement (= layout.fields 順)
  const fieldStores: number[] = [];
  for (let idx = 0; idx < slot.fields.length; idx++) {
    const field = slot.fields[idx]!;
    const valueAst = fieldValueByName.get(field.name);
    /* v8 ignore next 3 — capture 段 階 で 1 番 目 emit の seal + 後 続 emit の
       field set 整 合 check で 排 除 済 = 構 造 上 unreachable defensive guard */
    if (valueAst === undefined) {
      throw new Error(`event "${node.name}" missing AST for field "${field.name}"`);
    }
    const ptr =
      idx === 0
        ? slotPtrTee // 1 番 目 store で local hold
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
 * `message.onReceive` drain emit (= sub-phase 7.7c、 `02-messaging.md` §5.3)。
 *
 * per-quantum 開 始 で 該 当 ring を drain (= tail → head walk + 各 slot で
 * handler body を 走 ら す)。 drain 末 尾 で tail を head に commit (= main 側 が
 * Atomics.store(head) で push し た 全 slot を 1 quantum 内 で 完 全 消 化)。
 *
 * loop 形:
 *   $tail = load(base + 4)
 *   $head = load(base + 0)
 *   block break
 *     loop continue
 *       if ($tail == $head) br break
 *       $slot_ptr = base + 12 + ($tail % capacity) × slotSize
 *       <handler body>  (messageFieldRead は $slot_ptr + field.offsetInSlot)
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

  // handler body emit (= messageFieldRead は $slot_ptr 経 由 で hit、 既 emit
  // 経 路 で 解 決 さ れ る)。
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
