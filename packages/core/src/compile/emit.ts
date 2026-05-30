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
 * `frac` 用 f32 temp local。 frac(x) = x - floor(x) で x を 2 度 参 照 する =
 * `tee` で 1 度 だ け 評 価 + local hold し、 floor 側 で `get` で 再 取 得。 WASM は
 * 厳 密 な 左→右 評 価 + emit は optimizer を 回 さ な い の で、 `tee(L,…)` 直 後 に
 * `get(L)` で 消 費 し 間 に L を 書 く 操 作 が な い 限 り、 ネ ス ト (= frac(frac(x)))
 * で も 取 り 違 え が 起 き な い (= 内 側 が 完 全 評 価 さ れ た 後 に 外 側 tee が L 上 書 き)。
 */
const FRAC_F32_LOCAL = 7;

/**
 * `mod` 用 f32 temp local 3 つ。 mod(a,b) = a - trunc(a/b)·b で a / b / quotient を
 * 複 数 回 参 照 = local hold で 1 度 ず つ 評 価。 quotient (= MOD_Q) は 無 限 大 除 数
 * guard で 2 度 参 照 す る (= `0·Inf=NaN` 回 避、 後 述)。 ネ ス ト 安 全 性: a は 最 外
 * `sub` 左 operand で stack へ push し て 持 ち 回 り、 b / quotient は rhs 評 価・quotient
 * 算 出 後 に だ け read す る の で、 内 側 mod が 同 local を 上 書 き し て も 取 り 違 え ナ シ。
 */
const MOD_A_F32_LOCAL = 8;
const MOD_B_F32_LOCAL = 9;
const MOD_Q_F32_LOCAL = 10;

/**
 * f64 temp locals (= f32 版 と 同 役 割、 f64 path 用)。 frac の 二 重 評 価 回 避 と
 * mod の JS `%` 準 拠 special impl で 使 う。
 */
const FRAC_F64_LOCAL = 11;
const MOD_A_F64_LOCAL = 12;
const MOD_B_F64_LOCAL = 13;
const MOD_Q_F64_LOCAL = 14;

/**
 * `buffer.readInterpolated` 用 temp local。 pos を 1 度 評 価 し て f32 local に
 * hold (= floor index と frac で 2 度 参 照)、 切 り 出 し た integer index を i32
 * local に hold (= i / i+1 の 2 tap address で 2 度 参 照)。 二 重 評 価 回 避。
 */
const BUFINTERP_POS_LOCAL = 15;
const BUFINTERP_I0_LOCAL = 16;

/**
 * `payloadField.at(idx)` の OOB clamp 用 i32 temp local (= §4.3)。 idx を 1 度 評 価 +
 * local hold し、 `min(idx, length-1)` → `max(_, 0)` の 2 段 select で [0, length-1]
 * に 丸 め て か ら content load する (= runtime trap 排 除、 idx を 複 数 回 参 照)。
 */
const PAYLOAD_CLAMP_LOCAL = 17;

/**
 * 多 項 式 近 似 の math primitive (= sin / cos / tan / tanh / exp / log、 Q17) は
 * 共 有 プ ラ イ ベ ー ト WASM 関 数 (= `(f32) -> f32`、 export し な い) と し て emit し、
 * 呼 び 出 し 側 は `call` で 参 照。 各 関 数 は 自 前 の local を 持 つ の で `process`
 * 側 の 固 定 temp local と 干 渉 し な い。 graph で 実 際 に 使 わ れ て い る kind だ け
 * 追 加 す る (= `collectUsedMathKinds`)。
 */
const MATH_FN_PREFIX = "$unworklet_";

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
  // buffer.copyFrom が `memory.copy` (= bulk-memory) を emit する (= Q31-c)。
  // 既定 features (MVP) に BulkMemory を足して emitBinary が opcode を出せるように。
  mod.setFeatures(mod.getFeatures() | binaryen.Features.BulkMemory);

  const pages = Math.max(1, Math.ceil(layout.totalBytes / PAGE_BYTES));
  mod.setMemory(pages, pages, "memory");

  // 多 項 式 近 似 の math primitive (= sin 等、 Q17) を 共 有 プ ラ イ ベ ー ト 関 数 と し て
  // 追 加。 graph で 使 わ れ て い る kind だ け emit。
  addMathFunctions(collectUsedMathKinds(graph), mod, binaryen);

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
      binaryen.f32, // FRAC_F32_LOCAL (= frac 用 temp)
      binaryen.f32, // MOD_A_F32_LOCAL (= mod 被 除 数 temp)
      binaryen.f32, // MOD_B_F32_LOCAL (= mod 除 数 temp)
      binaryen.f32, // MOD_Q_F32_LOCAL (= mod quotient temp)
      binaryen.f64, // FRAC_F64_LOCAL
      binaryen.f64, // MOD_A_F64_LOCAL
      binaryen.f64, // MOD_B_F64_LOCAL
      binaryen.f64, // MOD_Q_F64_LOCAL
      binaryen.f32, // BUFINTERP_POS_LOCAL
      binaryen.i32, // BUFINTERP_I0_LOCAL
      binaryen.i32, // PAYLOAD_CLAMP_LOCAL (= at OOB clamp idx)
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

/** The binaryen float namespace for a scalar type (`f64` or `f32`). */
function floatNs(mod: BinaryenModule, type: ScalarType) {
  return type === "f64" ? mod.f64 : mod.f32;
}

/**
 * Type-dispatched numeric binary op (= 多 型 arithmetic / comparison lowering)。
 * `op` は binaryen 命 令 名 (= comparison は `le` / `ge`、 AST kind の `lte` /
 * `gte` を 呼 び 出 し 側 で map)。 整 数 は 符 号 付 き (= `div_s` / `lt_s` 等)。
 * i64 dispatch は i64 stage で 追 加。
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
  // i64 = 符 号 付 き (= div_s / lt_s 等)。 comparison は i32 (= bool 0/1) を 返 す。
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
 * `i64.const` from a bigint. binaryen 129 の `i64.const` は 単 一 bigint 引 数 を
 * 取 る が bundled d.ts は 旧 `(low, high)` signature の ま ま (= 実 装 と 不 一 致)。
 * member 式 を inline call し て cast = `this` 束 縛 を 保 っ た ま ま 型 を 通 す。
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
 * Transcendental call (= sin / cos / tan / tanh / exp / log)。 共 有 関 数 は
 * `(f32) -> f32` (= Q17 多 項 式 近 似、 関 数 本 体 は `addMathFunctions` で 追 加)。
 * f64 operand は f32-bridge で 通 す: `promote(call(demote(value)))`。 共 有 関 数 を
 * 型 ご と に 複 製 せ ず、 精 度 を f32 相 当 (~1e-4) に 揃 え る (= 型 不 問 の
 * approximate-math 契 約)。 `value` は emit 済 の expression (= node.type に 一 致)。
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
 * Cross-precision convert lowering (= scalar constructor `f32(node)` 等、 no-trap:
 * integer truncation は saturating)。 i32 ↔ f32 / i32 ↔ f64 / f32 ↔ f64 を 実 装、
 * i64 / bool pair は 各 stage で 追 加。
 */
function emitConvert(mod: BinaryenModule, from: ScalarType, to: ScalarType, value: number): number {
  if (from === "i32" && to === "f32") return mod.f32.convert_s.i32(value);
  if (from === "f32" && to === "i32") return mod.i32.trunc_s_sat.f32(value);
  if (from === "i32" && to === "f64") return mod.f64.convert_s.i32(value);
  if (from === "f64" && to === "i32") return mod.i32.trunc_s_sat.f64(value);
  if (from === "f32" && to === "f64") return mod.f64.promote(value);
  if (from === "f64" && to === "f32") return mod.f32.demote(value);
  // i64 は bigint-only construction (= 昇 格 convert ナ シ)、 narrowing だ け: i32 へ
  // は wrap (= 下 位 32bit)、 f32 / f64 へ は signed convert。
  if (from === "i64" && to === "i32") return mod.i32.wrap(value);
  if (from === "i64" && to === "f32") return mod.f32.convert_s.i64(value);
  if (from === "i64" && to === "f64") return mod.f64.convert_s.i64(value);
  /* v8 ignore next 2 — 残 り convert pair (= bool) は bool stage で fill、 該 当 type の node は ま だ 構 築 不 可 */
  throw new Error(`unworklet: convert ${from} → ${to} not implemented yet`);
}

// ─────────────────────────────────────────────────────────────────────────
// buffer scalar access (= `01-dsl.md` §3.2)。 element ptr = base + index ×
// sizeof。 u8 は 1 byte load8_u / store8 (= 下 位 8 bit)、 bool は i32 word。
// ─────────────────────────────────────────────────────────────────────────

const BUFFER_ELEMENT_BYTES_EMIT: Record<BufferElementType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
  u8: 1,
};

/** element pointer = bufferBase + index × sizeof(elementType)。 */
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
      // u8 = zero-extended 下 位 8 bit → Node<'i32'>。
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
      // 下 位 8 bit だ け store (= i32.store8)。
      return mod.i32.store8(0, 1, ptr, value);
  }
}

/** Convert a loaded buffer element to f32 (= f32-domain interpolation 用)。 */
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

/** Convert an interpolated f32 back to the element's surfaced scalar type。 */
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
 * `buffer.readInterpolated(pos)` = 線 形 補 間 (= 2-tap)。 pos を f32 local に
 * hold、 i0 = trunc(pos) を i32 local に hold (= 二 重 評 価 回 避)。 frac =
 * pos - i0、 a = buf[i0]、 b = buf[i0+1]、 result = a + (b - a)·frac。 補 間 は
 * f32 domain (= element を f32 に 変 換 し て 計 算 後、 element の scalar 型 へ 戻 す)。
 * f64 buffer も f32 domain で 行 う (= wavetable 用 途 で 可 聴 差 ナ シ、 Q17 と 同 軸)。
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
// typed-array payload reads (= `01-dsl.md` §4.3、 message onReceive handler)。
// slot の [payloadLen, payloadOffset] (= EVENT_SLOT_PTR_LOCAL 経 由) + message
// 別 payloadContent region base で 可 変 長 中 身 を index read / 要 素 数 取 得。
// ─────────────────────────────────────────────────────────────────────────

function payloadSlotMeta(
  node: AstNode & { kind: "payloadFieldRead" | "payloadFieldLength" },
  layout: Layout,
): { offsetInSlot: number; contentBase: number; elemBytes: number } {
  const slot = layout.regions.messageRings.slots[node.messageName];
  /* v8 ignore next 3 — payloadFieldRead/Length は proxy 経 由 で 宣 言 済 message を 参 照 = unreachable guard */
  if (slot === undefined) {
    throw new Error(`unknown message: ${node.messageName}`);
  }
  const field = slot.fields.find((f) => f.name === node.field);
  /* v8 ignore next 3 — field は proxy 経 由 で decl.fields に push 済 = unreachable guard */
  if (field === undefined) {
    throw new Error(`unknown message payload field: ${node.messageName}.${node.field}`);
  }
  const content = layout.regions.payloadContent.slots[node.messageName];
  /* v8 ignore next 3 — typed-array field を 持 つ message は payloadContent に slot 既 push */
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
  // payloadLen (= bytes) を slot か ら load し、 element 数 = payloadLen / sizeof。
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
  // length = payloadLen (bytes) / sizeof。 OOB clamp の upper bound = length - 1。
  const upper = (): number =>
    mod.i32.sub(
      mod.i32.div_s(
        mod.i32.load(0, BYTES_PER_I32, mod.i32.add(slotPtr(), mod.i32.const(offsetInSlot))),
        mod.i32.const(elemBytes),
      ),
      mod.i32.const(1),
    );
  const clamp = (): number => mod.local.get(PAYLOAD_CLAMP_LOCAL, binaryen.i32);
  // payloadOffset (= contentBase 内 byte offset) を slot の offsetInSlot+4 か ら load。
  const payloadOffset = mod.i32.load(
    0,
    BYTES_PER_I32,
    mod.i32.add(slotPtr(), mod.i32.const(offsetInSlot + 4)),
  );
  // addr = contentBase + payloadOffset + clampedIdx × sizeof (= clampedIdx は block 内
  // で [0, length-1] に 丸 め 済 を local.get)。
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
  // §4.3 select carrier-clamp: idx を 1 度 評 価 → [0, length-1] に 2 段 select で 丸 め →
  // content load。 OOB (idx ≥ length or < 0) で も addr が payload 内 に 留 ま り trap し な い。
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
      emitBufferLoad(mod, node.elementType, addr),
    ],
    blockType,
  );
}

// buf.copyFrom(payloadField) = content region → buffer の bulk `memory.copy` (= Q31-c)。
// copyBytes = min(payloadLen, bufferSize × sizeof) (= min(buf.size, src.length) を byte 換 算)。
function emitBufferCopyFrom(
  node: AstNode & { kind: "bufferCopyFrom" },
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  const base = layout.regions.buffers.slots[node.bufferName];
  /* v8 ignore next 3 — buffer は宣言済 = layout に slot 既 push の unreachable guard */
  if (base === undefined) {
    throw new Error(`unknown buffer: ${node.bufferName}`);
  }
  const slot = layout.regions.messageRings.slots[node.messageName];
  const field = slot?.fields.find((f) => f.name === node.field);
  const content = layout.regions.payloadContent.slots[node.messageName];
  /* v8 ignore next 3 — typed-array field 持 ち の message は slot + payloadContent 既 push */
  if (slot === undefined || field === undefined || content === undefined) {
    throw new Error(`unknown message payload field: ${node.messageName}.${node.field}`);
  }
  const elemBytes = BUFFER_ELEMENT_BYTES_EMIT[node.elementType];
  // payloadLen (= bytes) / payloadOffset を slot か ら load (= 評 価 ご と に fresh node)。
  const slotPtr = (): number => mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32);
  const payloadLen = (): number =>
    mod.i32.load(0, BYTES_PER_I32, mod.i32.add(slotPtr(), mod.i32.const(field.offsetInSlot)));
  const payloadOffset = mod.i32.load(
    0,
    BYTES_PER_I32,
    mod.i32.add(slotPtr(), mod.i32.const(field.offsetInSlot + 4)),
  );
  const destCapBytes = (): number => mod.i32.const(node.bufferSize * elemBytes);
  // copyBytes = min(payloadLen, destCapBytes) = select(len < cap, len, cap)。
  const copyBytes = mod.select(
    mod.i32.lt_u(payloadLen(), destCapBytes()),
    payloadLen(),
    destCapBytes(),
  );
  const destAddr = mod.i32.const(base);
  const srcAddr = mod.i32.add(mod.i32.const(content.base), payloadOffset);
  return mod.memory.copy(destAddr, srcAddr, copyBytes);
}

export function emitExpression(
  node: AstNode,
  layout: Layout,
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): number {
  switch (node.kind) {
    case "literal": {
      // i64 literal は bigint (= Q33-c)。
      if (node.type === "i64") {
        return i64Const(mod, BigInt(node.value));
      }
      // bool は 内 部 i32 表 現 (= 0/1) な の で i32.const に 落 と す (= select の
      // boolean branch literal 等)。 残 り は 全 て JS number。
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
      return mod.local.get(LOOP_COUNTER_LOCAL, binaryen.i32);
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
    // mod(a, b) = a - trunc(a/b)·b (= JS `%` 準 拠、 切 り 捨 て・符 号 は 被 除 数)。
    // a を MOD_A、 b を MOD_B、 quotient=trunc(a/b) を MOD_Q に hold。
    //   - b=0 → a/0=Inf → trunc=Inf → Inf·0=NaN → a-NaN=NaN (= JS x%0=NaN)。
    //   - 無 限 大 除 数 (|b|=Inf、 a 有 限) は quotient=trunc(a/Inf)=0 で 素 朴 な
    //     product=0·Inf=NaN に 化 け る が、 JS は 5%Infinity===5 = 被 除 数 を 返 す。
    //     quotient==0 (⟺ |a|<|b| = 余 り が a 自 身) な ら product を 0 に 固 定 し て
    //     修 正 (= div by zero 等 で 生 じ た Inf が divisor に 流 れ て も 有 限 被 除 数 を
    //     壊 さ な い、 Reported by @codex on #6)。 Inf%5 / Inf%Inf は quotient≠0 の ま ま
    //     NaN を 維 持。
    // ネ ス ト 安 全 性: a は 最 外 `sub` 左 operand で stack へ push し て 持 ち 回 り、
    // b / quotient は rhs 評 価・quotient 算 出 後 に だ け read = 内 側 mod の local
    // 上 書 き と 取 り 違 え ナ シ。 select は 直 前 の set で MOD_Q / MOD_B が 確 定 済 み。
    case "mod": {
      // Integer remainder = signed `rem_s` (= WASM 標 準、 符 号 は 被 除 数)。
      // float (f32 / f64) は 下 の JS `%` 準 拠 special impl。
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
      // f64: f32 版 と 同 じ JS `%` 準 拠 special impl を f64 local で。
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
      // get(MOD_A) は rhs 評 価 前 に read = a (内 側 mod の 上 書 き 前)。 同 時 に b を tee。
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
      return floatNs(mod, node.type).abs(emitExpression(node.value, layout, mod, binaryen));
    case "neg":
      return emitNeg(mod, node.type, emitExpression(node.value, layout, mod, binaryen));
    case "sqrt":
      return floatNs(mod, node.type).sqrt(emitExpression(node.value, layout, mod, binaryen));
    case "floor":
      return floatNs(mod, node.type).floor(emitExpression(node.value, layout, mod, binaryen));
    case "ceil":
      return floatNs(mod, node.type).ceil(emitExpression(node.value, layout, mod, binaryen));
    // frac(x) = x - floor(x) (= GLSL fract、 結 果 は [0,1))。 x を FRAC_F32_LOCAL に
    // tee し て 1 度 だ け 評 価、 floor 側 で get で 再 取 得 (= 二 重 評 価 回 避)。
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
    // 多 項 式 近 似 の math primitive は 共 有 関 数 (= `(f32) -> f32`) を call。
    // f64 form は f32-bridge: demote → call → promote (= Q17 = 型 不 問 の
    // approximate-math 契 約、 精 度 は f32 相 当 ~1e-4)。
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
      return floatNs(mod, node.type).max(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    case "min":
      return floatNs(mod, node.type).min(
        emitExpression(node.lhs, layout, mod, binaryen),
        emitExpression(node.rhs, layout, mod, binaryen),
      );
    // 比 較 (= 結 果 は i32 0/1 = bool 内 部 表 現、 state.bool / select cond /
    // emitIf cond で 利 用 さ れ る 既 存 bool=i32 表 現 と zip)
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
    // clamp(x, lo, hi) = min(max(x, lo), hi)。 各 オ ペ ラ ン ド を 1 度 ず つ emit =
    // 二 重 評 価 ナ シ = temp local 不 要。 lo > hi の 退 化 ケ ー ス は hi を 返 す
    // (= max(x,lo) >= lo > hi な の で min(..., hi) = hi)、 決 定 的 挙 動。
    case "clamp": {
      const fl = floatNs(mod, node.type);
      return fl.min(
        fl.max(
          emitExpression(node.x, layout, mod, binaryen),
          emitExpression(node.lo, layout, mod, binaryen),
        ),
        emitExpression(node.hi, layout, mod, binaryen),
      );
    }
    // select(cond, then, else) = WASM `select` 命 令 (= eager: 全 3 引 数 を 評 価
    // し て か ら 選 ぶ)。 then / else は 副 作 用 ナ シ の pure expression な の で
    // eager で 意 味 不 変。 cond は i32 (= bool 0/1)。
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
    case "bufferWrite":
    case "bufferCopyFrom":
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
  // typed-array field (§4.3) の emit メタ (= bufferName + length + elementType)。
  const emitFieldByName = new Map(node.fields.map((f) => [f.name, f] as const));

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
    // typed-array field (§4.3 worklet→main) = buffer の中身を event content region に
    // memory.copy + slot に [payloadLen, payloadOffset]。 payloadOffset = 0 固 定 (=
    // 単 一 payload 前 提、 content ring 管 理 は message offline 注 入 と 同 じ く 後 続)。
    // copyBytes = min(length × sizeof, content.capacity) で region 越 え を truncate。
    // atSample が 常 に idx 0 = typed-array field は idx ≥ 1 = slotPtrTee 後 =
    // EVENT_SLOT_PTR_LOCAL 確 定 済。
    if (field.payloadElementType !== undefined) {
      const emitField = emitFieldByName.get(field.name);
      const content = layout.regions.payloadContent.slots[node.name];
      const bufferBase =
        emitField?.bufferName !== undefined
          ? layout.regions.buffers.slots[emitField.bufferName]
          : undefined;
      /* v8 ignore next 6 — typed-array emit field は declarations で bufferName +
         length + payloadContent を 揃 え て push 済 = 構 造 上 unreachable guard */
      if (emitField?.length === undefined || content === undefined || bufferBase === undefined) {
        throw new Error(`event "${node.name}" typed-array field "${field.name}" missing emit meta`);
      }
      const elemBytes = BUFFER_ELEMENT_BYTES_EMIT[field.payloadElementType];
      const slotFieldPtr = (): number =>
        mod.i32.add(
          mod.local.get(EVENT_SLOT_PTR_LOCAL, binaryen.i32),
          mod.i32.const(field.offsetInSlot),
        );
      const lengthBytes = (): number =>
        mod.i32.mul(
          emitExpression(emitField.length!, layout, mod, binaryen),
          mod.i32.const(elemBytes),
        );
      // copyBytes = min(length × sizeof, content.capacity)。
      const copyBytes = (): number =>
        mod.select(
          mod.i32.lt_u(lengthBytes(), mod.i32.const(content.capacity)),
          lengthBytes(),
          mod.i32.const(content.capacity),
        );
      fieldStores.push(
        mod.block(null, [
          mod.i32.store(0, BYTES_PER_I32, slotFieldPtr(), copyBytes()), // payloadLen
          mod.i32.store(
            0,
            BYTES_PER_I32,
            mod.i32.add(slotFieldPtr(), mod.i32.const(4)),
            mod.i32.const(0),
          ), // payloadOffset = 0
          mod.memory.copy(mod.i32.const(content.base), mod.i32.const(bufferBase), copyBytes()),
        ]),
      );
      continue;
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

// ─────────────────────────────────────────────────────────────────────────
// 多 項 式 近 似 math primitive の 共 有 関 数 emit (= Q17、 sin / cos / tan / tanh /
// exp / log)。 5〜7 次 minimax / Taylor、 最 大 誤 差 ~1e-4 = 24bit audio で 不 可 聴。
// no-trap invariant: 整 数 化 は trunc_s_sat (= 飽 和・非 ト ラ ッ プ)、 reinterpret /
// nearest / convert は 元 々 非 ト ラ ッ プ。
// ─────────────────────────────────────────────────────────────────────────

const TRANSCENDENTAL_KINDS: ReadonlySet<string> = new Set([
  "sin",
  "cos",
  "tan",
  "tanh",
  "exp",
  "log",
]);

/** graph の AST を walk し て 実 際 に 使 わ れ て い る transcendental kind を 収 集。 */
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
        // math 関 数 を 含 む 子 expression ナ シ。
        break;
      case "bufferWrite":
        visit(node.index);
        visit(node.value);
        break;
      case "forSample":
      case "messageOnReceive":
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
      case "literal":
      case "loopCounter":
      case "stateLoad":
      case "messageFieldRead":
        break;
    }
  };
  graph.statements.forEach(visit);
  return used;
}

/**
 * 依 存 展 開: cos / tan は sin を、 tan は cos も call す る (= 派 生 実 装)。 必 要 な
 * base 関 数 も used set に 含 め る。
 */
function expandMathDeps(used: Set<string>): Set<string> {
  const out = new Set(used);
  if (out.has("cos") || out.has("tan")) out.add("sin");
  if (out.has("tan")) out.add("cos");
  if (out.has("tanh")) out.add("exp");
  return out;
}

/** used kind に 応 じ て 共 有 math 関 数 を module に 追 加 (= 依 存 順)。 */
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
 * `$unworklet_sin`: range reduce r = x - round(x/π)·π ∈ [-π/2, π/2] し、 odd
 * Taylor 9 次 で sin(r) を 評 価、 sign = (-1)^round(x/π) を 掛 け る。 [-π/2,π/2]
 * で の Taylor 9 次 誤 差 は ~3e-5 (= 1e-4 以 下)。 locals: 0=x(param) / 1=k_f /
 * 2=r / 3=z(=r²) / 4=k_i。
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

/** `$unworklet_cos`: cos(x) = sin(x + π/2) で sin 関 数 に 委 譲。 locals ナ シ。 */
function buildCosFn(mod: BinaryenModule, binaryen: BinaryenAPI): void {
  const f = binaryen.f32;
  const body = mod.call(
    `${MATH_FN_PREFIX}sin`,
    [mod.f32.add(mod.local.get(0, f), mod.f32.const(MATH_PI / 2))],
    binaryen.f32,
  );
  mod.addFunction(`${MATH_FN_PREFIX}cos`, binaryen.f32, binaryen.f32, [], body);
}

/** `$unworklet_tan`: tan(x) = sin(x)/cos(x)。 x は param local = 自 由 に 再 取 得。 */
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
 * `$unworklet_exp`: x = k·ln2 + r (= k=round(x/ln2)、r∈[-ln2/2,ln2/2]) と 分 解 し、
 * exp(x) = 2^k · exp(r)。 exp(r) は degree-5 Taylor (= 誤 差 ~2.4e-6)、 2^k は
 * `(k+127)<<23` を f32 に reinterpret。 locals: 0=x(param) / 1=k_f / 2=r / 3=k_i。
 * k が f32 指 数 範 囲 外 (= k>127 / k<-126) で は bit-pack が wrap し て garbage に
 * な る の で、 select で overflow→+Inf / underflow→0 に clamp し て `Math.exp`
 * 準 拠 (= 非 ト ラ ッ プ)。 tanh も exp(2x) 経 由 で 大 負 入 力 が ±1 飽 和 す る。
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
      // k が f32 指 数 範 囲 外 = overflow → +Inf / underflow → 0 に clamp。
      // select は eager だ が twoK·poly の garbage は 範 囲 外 で 捨 て ら れ る だ け。
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
 * `$unworklet_log`: x = m·2^e (= e は f32 指 数 bit、 m∈[1,2) は 仮 数 bit を 指 数 127
 * に 固 定 し て reinterpret)。 log(x) = e·ln2 + log(m)、 log(m) は t=(m-1)/(m+1) の
 * atanh 級 数 2·(t + t³/3 + t⁵/5 + t⁷/7) (= t∈[0,1/3]、 誤 差 ~3e-6)。 定 義 域 外 /
 * 特 殊 値 は select で `Math.log` 準 拠 (= x<0 → NaN、 x==0 → -Inf、 NaN → NaN、
 * +Inf → +Inf)、 非 ト ラ ッ プ。 subnormal 入 力 は bit 分 解 前 に 2^24 倍 で normal
 * 域 へ 正 規 化 し 結 果 を 24·ln2 補 正 (= exponent field=0 の 破 綻 回 避)。
 * locals: 0=x(param) / 1=bits(i32) / 2=m / 3=t / 4=s(=t²) / 5=xn(正 規 化 後 入 力)。
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
  // 最 小 normal f32 = 2^-126。 こ れ 未 満 (= subnormal、 exponent field=0) は
  // 素 朴 な bit 分 解 が 破 綻 す る の で、 2^24 倍 し て normal 域 に 押 し 上 げ て か ら
  // 分 解 し、 log 結 果 か ら 24·ln2 を 引 い て 補 正 す る (全 subnormal は 2^24 で
  // normal 域 に 収 ま る: 最 小 値 2^-149·2^24 = 2^-125)。
  const FLT_MIN_NORMAL = 2 ** -126;
  const SUBNORMAL_SCALE = 2 ** 24;
  const SUBNORMAL_LOG_OFFSET = 24 * MATH_LN2;
  const isSubnormal = (): number => mod.f32.lt(mod.local.get(X, f), mod.f32.const(FLT_MIN_NORMAL));
  const s = (): number => mod.local.get(S, f);
  // log(m) 多 項 式: poly_t = 1 + s·(1/3 + s·(1/5 + s·(1/7)))、 log(m) = 2·t·poly_t
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
  // subnormal を 2^24 倍 し た 分 だ け eF が 24 大 き く 出 る の で 24·ln2 を 引 い て 戻 す。
  const computed = mod.f32.sub(
    mod.f32.add(mod.f32.mul(eF, mod.f32.const(MATH_LN2)), logM),
    mod.select(isSubnormal(), mod.f32.const(SUBNORMAL_LOG_OFFSET), mod.f32.const(0)),
  );
  const body = mod.block(
    null,
    [
      // xn = x · (subnormal ? 2^24 : 1)。 以 降 の bit 分 解 は xn に 対 し て 行 う。
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
        // x>0 の 枝: +Inf は bit 分 解 す る と m=1·2^128 で 128·ln2 付 近 の 有 限 値 に
        // 化 け る の で 先 に 捕 ま え て +Inf を 保 つ。 有 限 正 値 だ け 近 似 を 通 す。
        mod.select(
          mod.f32.eq(mod.local.get(X, f), mod.f32.const(Number.POSITIVE_INFINITY)),
          mod.f32.const(Number.POSITIVE_INFINITY),
          computed,
        ),
        // x<=0 / NaN の 枝: x==0 だ け -Inf、 そ れ 以 外 (= 負 値 / NaN) は NaN。
        // NaN は gt も eq(0) も false に な る の で 自 然 に NaN 側 に 落 ち る。
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
 * `$unworklet_tanh`: tanh(x) = 1 - 2/(exp(2x)+1) で exp 関 数 に 委 譲。 分 子 が 有 限
 * (= 2) な の で 大 入 力 で も Inf/Inf に な ら ず ±1 に 飽 和。 exp の rel 誤 差 が
 * tanh で は 1.2e-6 以 下 に 縮 む。 locals ナ シ (= x は param)。
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
