/**
 * Internal AST IR for graph capture (= plan Q-A).
 *
 * Tagged union with `kind` discriminant — exhaustive switch in
 * `analyze` / `layout` / `emit` stages catches missing branches at
 * TypeScript level, and the same shape serializes directly to
 * `dist/<processor>.graph.json` (= `07-vite-plugin.md` §6.3).
 *
 * 各 stage は 追 加 discriminant の switch case を 順 次 fill (= subset →
 * superset)。
 */

import type { BufferElementType, PublishOptions, ScalarType, SnapshotPolicy } from "../types.ts";

export type AstNode =
  // `value` is a JS `number` for every scalar type except `'i64'`, whose
  // literal carries a `bigint` (no implicit number lift, Q33-c) and lowers to
  // `i64.const`. `loose` marks a `num(v)` chain-start literal (Q77) whose type
  // is resolved from the chain's typed sibling (else stays the fallback `type`).
  | { kind: "literal"; type: ScalarType; value: number | bigint; loose?: boolean }
  | { kind: "mul"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "add"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "sub"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "div"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "mod"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "abs"; type: ScalarType; value: AstNode }
  | { kind: "neg"; type: ScalarType; value: AstNode }
  | { kind: "sqrt"; type: ScalarType; value: AstNode }
  | { kind: "floor"; type: ScalarType; value: AstNode }
  | { kind: "ceil"; type: ScalarType; value: AstNode }
  | { kind: "frac"; type: ScalarType; value: AstNode }
  | { kind: "sin"; type: ScalarType; value: AstNode }
  | { kind: "cos"; type: ScalarType; value: AstNode }
  | { kind: "tan"; type: ScalarType; value: AstNode }
  | { kind: "exp"; type: ScalarType; value: AstNode }
  | { kind: "log"; type: ScalarType; value: AstNode }
  | { kind: "tanh"; type: ScalarType; value: AstNode }
  | { kind: "max"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "min"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "eq"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "lt"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "gt"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "lte"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "gte"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "clamp"; type: ScalarType; x: AstNode; lo: AstNode; hi: AstNode }
  | { kind: "select"; type: ScalarType; cond: AstNode; ifTrue: AstNode; ifFalse: AstNode }
  // Cross-precision conversion between `Node` types (= scalar constructors
  // `f32(node)` / `i32(node)` / etc., `01-dsl.md` §2.2). `type` = target,
  // `from` = source. Lowers to a single WASM convert / trunc_sat / extend /
  // wrap / promote / demote instruction (no-trap: integer truncation uses the
  // saturating form). `from === type` is folded away at the constructor (no
  // convert node emitted), so emit always sees a genuine type change.
  | { kind: "convert"; type: ScalarType; from: ScalarType; value: AstNode }
  | { kind: "audioInRead"; portName: string; channel: number; offset: AstNode }
  | {
      kind: "audioOutWrite";
      portName: string;
      channel: number;
      offset: AstNode;
      value: AstNode;
    }
  | { kind: "paramAt"; paramName: string; offset: AstNode }
  | { kind: "loopCounter" }
  | { kind: "forSample"; stride: number; body: AstNode[] }
  | { kind: "stateLoad"; type: ScalarType; name: string }
  | { kind: "stateStore"; type: ScalarType; name: string; value: AstNode }
  | {
      kind: "eventEmitIf";
      name: string;
      cond: AstNode;
      atSample: AstNode;
      fields: EventEmitField[];
    }
  | { kind: "messageOnReceive"; name: string; body: AstNode[] }
  | { kind: "messageFieldRead"; name: string; field: string; wireType: ScalarType }
  // `buffer.<type>` scalar access (`01-dsl.md` §3.2). `elementType` is the
  // buffer's declared element type; the produced scalar type is the element
  // type itself, except `'u8'` reads/writes through `Node<'i32'>` (low 8 bits).
  | { kind: "bufferRead"; elementType: BufferElementType; name: string; index: AstNode }
  | {
      kind: "bufferWrite";
      elementType: BufferElementType;
      name: string;
      index: AstNode;
      value: AstNode;
    }
  | { kind: "bufferReadInterpolated"; elementType: BufferElementType; name: string; pos: AstNode }
  // Bulk copy a typed-array message payload field into a buffer via `memory.copy`
  // (`decisions-log.md` Q31-c). Realtime-safe alternative to a per-sample write
  // loop; copies `min(bufferSize, payloadLen / sizeof element)` elements. Used
  // inside a `message<T>` onReceive handler (= EVENT_SLOT_PTR drain context).
  | {
      kind: "bufferCopyFrom";
      elementType: BufferElementType;
      bufferName: string;
      bufferSize: number;
      messageName: string;
      field: string;
    }
  // Variable-length typed-array payload reads inside a `message<T>` onReceive
  // handler (`01-dsl.md` §4.3). The field's content lives in the payloadContent
  // region; the slot carries `[payloadLen, payloadOffset]`. `length` = element
  // count (= payloadLen bytes / sizeof element); `at` = single indexed element.
  | {
      kind: "payloadFieldLength";
      messageName: string;
      field: string;
      elementType: BufferElementType;
    }
  | {
      kind: "payloadFieldRead";
      messageName: string;
      field: string;
      elementType: BufferElementType;
      index: AstNode;
    };

/**
 * `eventDecl.emitIf` 1 emit site の 1 field 分 (= `01-dsl.md` §4.1 + Q71)。
 *
 * `wireType` = emit-time に 確 定 し た per-field wire 型 (= `Node<T>` の T を
 * lookup、 literal は lift 経 由 で 確 定)。 同 `event<T>` handle の 別 emit site
 * で 同 field 名 の `wireType` が 不 一 致 = graph-capture-time error。
 */
export type EventEmitField = {
  name: string;
  wireType: ScalarType;
  value: AstNode;
  /**
   * Present when the field is a variable-length typed array (§4.3 worklet → main).
   * `value` is then an unused placeholder; the bytes come from the worklet buffer
   * `bufferName`, `length` elements copied into the event content region at emit
   * time, and the slot carries `[payloadLen, payloadOffset]`.
   */
  payloadElementType?: BufferElementType;
  bufferName?: string;
  length?: AstNode;
};

export type AudioPortDecl = {
  kind: "audioInput" | "audioOutput";
  name: string;
  channels: number;
};

export type ParamDecl = {
  kind: "param";
  name: string;
  type: "f32";
  default: number;
  min: number;
  max: number;
  automationRate: "a-rate" | "k-rate";
};

/**
 * Scalar `state.<type>(initial)` slot declaration (`01-dsl.md` §3.1)。
 *
 * `initial` は scalar value (= f32/f64 → number、 i32 → number、 i64 →
 * bigint、 bool → boolean)。 SAB publish path (= 7.4) で の 型 変 換 と
 * 同 set。
 *
 * `snapshot` / `publish` は `.expose({...})` / `.named()` chain で 設 定
 * (= sub-phase 7.2、 `01-dsl.md` §3.1 + Q42 + Q79):
 * - `snapshot`: default ナ シ = worklet-private、 set あ り で snapshot blob 経 由 で 取 得 (= sub-phase 11 で fill)。 default は state / param で `'persistent'`、 buffer で `'transient'`。
 * - `publish`: set あ り で main thread 公 開 (= sub-phase 7.3-7.5 で SAB / postMessage 経 由)。 type 制 限 = f32 / i32 / bool で だ け 受 容 (= Q42)。
 */
export type StateDecl = {
  kind: "state";
  name: string;
  type: ScalarType;
  initial: number | bigint | boolean;
  snapshot?: SnapshotPolicy;
  publish?: PublishOptions;
  /**
   * `.named('X')` or `.expose({ name: 'X' })` 経 由 で user が 明 示 指 定 し た
   * name か。 plain factory (= `state.f32(0)`) は synthetic name (= `__state_<idx>`)
   * で declare = `userNamed` 未 設 定 / false、 chain で 明 示 set さ れ た 段 階
   * で `true`。 finalize check で 「publish or snapshot 'persistent' は
   * user-defined name 必 須」 を 担 保 (= synthetic name path を invalid と し て
   * 落 と す)。 optional = test fixture で literal declare path を 維 持。
   */
  userNamed?: boolean;
};

/**
 * `event<T>(options)` declaration (`01-dsl.md` §4.1)。
 *
 * Worklet → main moment-in-time delivery 用 の ringbuffer-backed channel。
 * `T` の field 名 と 大 体 の 型 family (numeric / boolean / typed-array) は
 * declaration 段 階 で 確 定 し、 各 numeric field の wire 型 は emit-time に
 * `Node<T>` の lookup で 確 定 (= Q71)。 1 つ の `event<T>` handle へ の 複 数 emit
 * site で per-field 型 が 不 一 致 = graph-capture-time error (= stable ID
 * `event-field-type-mismatch`)。
 *
 * `capacity` = ringbuffer slot count (= `Capacity` literal-union で TS-level
 * enforce、 Q44)、 default = 256 (= `02-messaging.md` §4.1 + MIDI Q4-c-i)。
 * `payloadCapacity` = variable-length payload (= `Float32Array` / `Uint8Array`
 * field) 用 content buffer bytes、 declare 時 optional、 omit 時 framework が
 * 「最 大 期 待 payload × slot count」 で derive。
 */
export type EventDeclAst = {
  kind: "event";
  name: string;
  capacity: number;
  payloadCapacity?: number;
  /**
   * emit site で 確 定 し た per-field wire 型 を accumulate (= Q71)。 declare
   * 直 後 は 空、 1 番 目 の emit site で 各 field の wire 型 を seal + 後 続
   * emit site は 同 field 名 / 同 wire 型 を 強 制。 multi-emit-site で
   * 不 一 致 (= 同 field 名 で wire 型 違 い、 field 名 が 違 う) = graph-capture-time
   * error (= stable ID `event-field-type-mismatch`)。
   */
  fields: EventDeclField[];
};

export type EventDeclField = {
  name: string;
  wireType: ScalarType;
  /**
   * Present when the field is a variable-length typed array (§4.3 / §5.2). The
   * slot carries `[payloadLen, payloadOffset]` (8 bytes); content lives in the
   * event's `payloadContent` region.
   */
  payloadElementType?: BufferElementType;
};

/**
 * `message<T>(options)` declaration (`01-dsl.md` §4.2)。
 *
 * Main → worklet coarse-grained delivery 用 ringbuffer-backed channel。 handler
 * は `onReceive(handler)` 経 由 で per-block top に 登 録、 quantum 開 始 で drain
 * (= Q38-b: 全 handler が per-block / forSample よ り 先 に 走 る)。
 *
 * `T` の field 別 wire 型 は Q46 uniform lift rule: 全 number → i32 (= 4 byte)、
 * 全 boolean → bool (= 4 byte u32 align)、 typed-array → §5.2 variable-length
 * content buffer (= 後 続 sub-phase で fill)。 main 側 `node.messages.<name>(p)`
 * か ら 来 る payload は plain JS = framework が wire 化 し て worklet 内 で handler
 * を 起 動 = field 別 推 論 ナ シ で 全 uniform path。
 *
 * `fields` = onReceive handler が destructure し た field 名 + wire 型 (= number
 * は i32 / boolean は bool / typed-array は 後 続 fill)。 1 番 目 onReceive で seal、
 * 後 続 onReceive で 同 field 名 set / 同 wire 型 (= 既 sealed 集 合 と 整 合 check)。
 */
export type MessageDeclAst = {
  kind: "message";
  name: string;
  capacity: number;
  payloadCapacity?: number;
  fields: MessageDeclField[];
};

export type MessageDeclField = {
  name: string;
  wireType: ScalarType;
  /**
   * Present when the field is a variable-length typed array (`Float32Array` /
   * `Uint8Array`, §4.3 / §5.2). The field then occupies a `[payloadLen,
   * payloadOffset]` pair in the slot (not a scalar word) and indexes into the
   * payloadContent region; `wireType` is unused for such a field.
   */
  payloadElementType?: BufferElementType;
};

/**
 * `buffer.<type>({ size })` fixed-size array declaration (`01-dsl.md` §3.2).
 *
 * `type` は element type (= `ScalarType ∪ {'u8'}`)、 `size` は element count
 * (= byte size は `size × sizeof(type)`、 `u8` = 1 byte)。 `snapshot` / `publish`
 * / `userNamed` は state と 同 chain semantics (= `.named` / `.expose`、 default
 * snapshot は buffer で `'transient'`)。
 */
export type BufferDecl = {
  kind: "buffer";
  name: string;
  type: BufferElementType;
  size: number;
  snapshot?: SnapshotPolicy;
  publish?: PublishOptions;
  userNamed?: boolean;
};

export type Declaration =
  | AudioPortDecl
  | ParamDecl
  | StateDecl
  | BufferDecl
  | EventDeclAst
  | MessageDeclAst;

export type CapturedGraph = {
  declarations: Declaration[];
  statements: AstNode[];
};

/**
 * expression node の 結 果 ScalarType を 推 論。 `eventDecl.emitIf` の Q71
 * per-field wire-type resolution (= `01-dsl.md` §4.1) と、 analyze の
 * 非 f32 算 術 検 出 (= `03-compiler.md` §3) で 共 用。
 *
 * expression position に 立 つ kind だ け 受 け 取 る (= statement kind は
 * `unwrapAst` 段 階 で 排 除 さ れ る 想 定、 仮 に 来 て も 明 示 throw)。
 */
export function inferAstType(ast: AstNode): ScalarType {
  switch (ast.kind) {
    // 算 術 / math / 制 御 = 結 果 型 は node の `type` (= f32 path)。
    case "literal":
    case "mul":
    case "add":
    case "sub":
    case "div":
    case "mod":
    case "neg":
    case "abs":
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
    case "max":
    case "min":
    case "clamp":
    case "select":
    case "convert":
    case "stateLoad":
      return ast.type;
    // 比 較 = 結 果 は 常 に bool (= node の `type` は オ ペ ラ ン ド 型 f32)。
    case "eq":
    case "lt":
    case "gt":
    case "lte":
    case "gte":
      return "bool";
    case "audioInRead":
    case "paramAt":
      return "f32";
    case "loopCounter":
      return "i32";
    case "messageFieldRead":
      return ast.wireType;
    // buffer read result = element type, except `'u8'` surfaces as `'i32'`
    // (= low 8 bits, no separate `Node<'u8'>` in the scalar type system).
    case "bufferRead":
    case "bufferReadInterpolated":
    case "payloadFieldRead":
      return ast.elementType === "u8" ? "i32" : ast.elementType;
    case "payloadFieldLength":
      return "i32";
    case "audioOutWrite":
    case "forSample":
    case "stateStore":
    case "eventEmitIf":
    case "messageOnReceive":
    case "bufferWrite":
    case "bufferCopyFrom":
      throw new Error(`statement node '${ast.kind}' cannot appear in expression position`);
  }
}
