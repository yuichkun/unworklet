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

import type { PublishOptions, ScalarType, SnapshotPolicy } from "../types.ts";

export type AstNode =
  | { kind: "literal"; type: ScalarType; value: number }
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
  | { kind: "max"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "min"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "eq"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "lt"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "gt"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "lte"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "gte"; type: ScalarType; lhs: AstNode; rhs: AstNode }
  | { kind: "clamp"; type: ScalarType; x: AstNode; lo: AstNode; hi: AstNode }
  | { kind: "select"; type: ScalarType; cond: AstNode; then: AstNode; else: AstNode }
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
  | { kind: "messageFieldRead"; name: string; field: string; wireType: ScalarType };

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
};

export type Declaration = AudioPortDecl | ParamDecl | StateDecl | EventDeclAst | MessageDeclAst;

export type CapturedGraph = {
  declarations: Declaration[];
  statements: AstNode[];
};
