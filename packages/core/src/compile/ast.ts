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

import type {
  BufferElementType,
  MidiEventType,
  PublishOptions,
  ScalarType,
  SnapshotPolicy,
} from "../types.ts";

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
  | { kind: "not"; type: "bool"; value: AstNode }
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
  // SIMD f32x4 (`01-dsl.md` §7、Q59). vec-producing nodes (vecConst/vecSplat/vecAdd…)
  // are `Node<'f32x4'>`; vecLane / vecSumLanes reduce back to `Node<'f32'>`.
  | { kind: "vecConst"; lanes: [AstNode, AstNode, AstNode, AstNode] }
  | { kind: "vecSplat"; value: AstNode }
  | { kind: "vecAdd"; lhs: AstNode; rhs: AstNode }
  | { kind: "vecSub"; lhs: AstNode; rhs: AstNode }
  | { kind: "vecMul"; lhs: AstNode; rhs: AstNode }
  | { kind: "vecDiv"; lhs: AstNode; rhs: AstNode }
  | { kind: "vecLane"; index: number; value: AstNode }
  | { kind: "vecSumLanes"; value: AstNode }
  // SIMD buffer I/O (§7): load/store 4 contiguous f32 lanes at element offset.
  | { kind: "bufferLoadVec"; name: string; offset: AstNode }
  | { kind: "bufferStoreVec"; name: string; offset: AstNode; value: AstNode }
  // Cross-precision conversion between `Node` types (= scalar constructors
  // `f32(node)` / `i32(node)` / etc., `01-dsl.md` §2.2). `type` = target,
  // `from` = source. Lowers to a single WASM convert / trunc_sat / extend /
  // wrap / promote / demote instruction (no-trap: integer truncation uses the
  // saturating form). `from === type` is folded away at the constructor (no
  // convert node emitted), so emit always sees a genuine type change.
  | { kind: "convert"; type: ScalarType; from: ScalarType; value: AstNode }
  // Definition-order fix for mutable memory reads (`03-compiler.md` §2.7, issue
  // #8). A `stateLoad` / `bufferRead` / `bufferReadInterpolated` is captured
  // eagerly into a per-read WASM local at its lexical point: `tempAssign`
  // evaluates the read once into local `tempId` (recorded as a statement in
  // source order, before any enclosing statement), and every reference to the
  // bound `Node` becomes a `tempRef` that reads the local. A later `store` to
  // the same slot therefore cannot change what an already-bound `Node`
  // evaluates to — the lazy re-walk that read post-store memory is gone.
  | { kind: "tempAssign"; tempId: number; valueType: ScalarType; value: AstNode }
  | { kind: "tempRef"; tempId: number; type: ScalarType }
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
  // sub-rate sub-block inside a `forSample` callback (`01-dsl.md` §9, Q43). Runs
  // `body` on samples where `(counter % divisor) == 0`; the per-call-site counter
  // advances by `stride` each iteration and is continuous across render quanta.
  | {
      kind: "everyNSamples";
      divisor: number;
      stride: number;
      counterId: number;
      body: AstNode[];
    }
  | {
      kind: "eventEmitIf";
      name: string;
      cond: AstNode;
      atSample: AstNode;
      fields: EventEmitField[];
    }
  | { kind: "messageOnReceive"; name: string; body: AstNode[] }
  | { kind: "messageFieldRead"; name: string; field: string; wireType: ScalarType }
  // MIDI (`11-midi.md`). Inbound: `midiInput().onEvent(type, handler)` registers a
  // type-discriminated handler whose body drains the port's ringbuffer at the
  // block boundary (Q38-b). `midiFieldRead` reads one decoded field of the
  // current drain slot (= channel/note/velocity/… resolved per event type).
  // Outbound: `midiOutput().emitIf(cond, event)` serializes a MidiEventGraph into
  // the output ringbuffer (wire bytes computed in emit from the semantic args).
  | { kind: "midiOnEvent"; port: string; eventType: MidiEventType; body: AstNode[] }
  | { kind: "midiFieldRead"; field: MidiByteField }
  // Inbound sysex (`11-midi.md` §4.3): the current drain slot's content chunk
  // length, and a bulk copy of its bytes into a `buffer.u8` (the realtime-safe
  // ingest path — `buf.copyFrom(data)` inside a `sysex` handler).
  | { kind: "midiSysexLength"; port: string }
  | { kind: "midiSysexCopy"; port: string; bufferName: string; bufferSize: number }
  | {
      kind: "midiEmitIf";
      port: string;
      eventType: MidiEventType;
      cond: AstNode;
      atSample: AstNode;
      // Non-sysex events carry a channel (omitted for systemRealtime, whose raw
      // status is `arg1`) plus two semantic data args; emit computes the 8-byte
      // wire slot [status, data1, data2, _pad, atSample] per `eventType`.
      channel?: AstNode;
      arg1?: AstNode;
      arg2?: AstNode;
      // Sysex (variable length): bytes come from a worklet-declared `buffer.u8`
      // (new content, `sysexBufferName`) or an inbound `TypedArrayFieldRef<'u8'>`
      // thru (`sysexSourcePort` = the source midiInput's content region);
      // `sysexLength` selects how many bytes ship into the port's content region.
      sysexBufferName?: string;
      sysexBufferSize?: number;
      sysexSourcePort?: string;
      sysexLength?: AstNode;
    }
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
  /** Source buffer の element 数 (= `buffer.<T>({ size })`)。emit が copy byte 数を buffer 境界に clamp する。 */
  bufferSize?: number;
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
  /**
   * Snapshot inclusion (`01-dsl.md` §3.3 + §8.2). Default `'persistent'` —
   * param values are typically the user-controlled preset state. `.expose({
   * snapshot })` overrides. Only the current value is snapshotted (automation
   * queues are not preserved).
   */
  snapshot?: SnapshotPolicy;
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
 * content buffer (= 後 続 sub-phase で fill)。 main 側 `node.events.<name>.emit(p)`
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

/**
 * Decoded field of a MIDI drain slot, read by `midiFieldRead` against the
 * current drain slot pointer. `channel` masks the status low nibble; `data1` /
 * `data2` are the two data bytes; `pitchBend14` recombines `data1 | data2 << 7`.
 * The handler proxy maps each semantic field (note / velocity / controller / …)
 * to one of these per event type (`11-midi.md` §2.2 / §4.1).
 */
export type MidiByteField = "status" | "channel" | "data1" | "data2" | "atSample" | "pitchBend14";

/** `event.midi({ from: 'main', name, capacity })` declaration (`11-midi.md` §1). */
export type MidiInputDecl = {
  kind: "midiInput";
  name: string;
  capacity: number;
};

/** `event.midi({ to: 'main', name, capacity })` declaration (`11-midi.md` §1). */
export type MidiOutputDecl = {
  kind: "midiOutput";
  name: string;
  capacity: number;
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
  | MessageDeclAst
  | MidiInputDecl
  | MidiOutputDecl;

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
    case "not":
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
    case "tempRef":
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
    case "midiFieldRead":
    case "midiSysexLength":
      // Every decoded MIDI field surfaces as a graph i32 (= `MidiEventGraph`).
      return "i32";
    // buffer read result = element type, except `'u8'` surfaces as `'i32'`
    // (= low 8 bits, no separate `Node<'u8'>` in the scalar type system).
    case "bufferRead":
    case "bufferReadInterpolated":
    case "payloadFieldRead":
      return ast.elementType === "u8" ? "i32" : ast.elementType;
    case "payloadFieldLength":
      return "i32";
    // SIMD reduction = scalar f32 (= lane 抽出 / horizontal sum)。
    case "vecLane":
    case "vecSumLanes":
      return "f32";
    // SIMD vec-producing = f32x4 = scalar 型 system 外 = scalar position は不正。
    case "vecConst":
    case "vecSplat":
    case "vecAdd":
    case "vecSub":
    case "vecMul":
    case "vecDiv":
    case "bufferLoadVec":
      throw new Error(`f32x4 node '${ast.kind}' cannot appear in scalar position`);
    case "bufferStoreVec":
      throw new Error(`statement node '${ast.kind}' cannot appear in expression position`);
    case "audioOutWrite":
    case "forSample":
    case "stateStore":
    case "eventEmitIf":
    case "messageOnReceive":
    case "bufferWrite":
    case "bufferCopyFrom":
    case "everyNSamples":
    case "tempAssign":
    case "midiOnEvent":
    case "midiEmitIf":
    case "midiSysexCopy":
      throw new Error(`statement node '${ast.kind}' cannot appear in expression position`);
  }
}
