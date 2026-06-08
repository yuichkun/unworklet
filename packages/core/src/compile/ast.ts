/**
 * Internal AST IR for graph capture (= plan Q-A).
 *
 * Tagged union with `kind` discriminant — exhaustive switch in
 * `analyze` / `layout` / `emit` stages catches missing branches at
 * TypeScript level, and the same shape serializes directly to
 * `dist/<processor>.graph.json` (= `07-unplugin.md` §6.3).
 *
 * Each stage progressively fills in switch cases for the additional
 * discriminants (= subset → superset).
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
  // SIMD f32x4 (`01-dsl.md` §7, Q59). vec-producing nodes (vecConst/vecSplat/vecAdd…)
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
 * One field of one `eventDecl.emitIf` emit site (= `01-dsl.md` §4.1 + Q71).
 *
 * `wireType` = the per-field wire type resolved at emit-time (= looked up from
 * the `T` of `Node<T>`; literals are resolved via lift). If the same field name
 * has a mismatched `wireType` at a different emit site of the same `event<T>`
 * handle, that is a graph-capture-time error.
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
  /** Element count of the source buffer (= `buffer.<T>({ size })`). Emit clamps the number of copied bytes to the buffer's bounds. */
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
 * Scalar `state.<type>(initial)` slot declaration (`01-dsl.md` §3.1).
 *
 * `initial` is a scalar value (= f32/f64 → number, i32 → number, i64 → bigint,
 * bool → boolean), the same set of type conversions as the SAB publish path
 * (= 7.4).
 *
 * `snapshot` / `publish` are configured via the `.expose({...})` / `.named()`
 * chain (= sub-phase 7.2, `01-dsl.md` §3.1 + Q42 + Q79):
 * - `snapshot`: unset by default = worklet-private; when set, the value is restored via the snapshot blob (= filled in by sub-phase 11). The default is `'persistent'` for state / param and `'transient'` for buffer.
 * - `publish`: when set, the value is exposed to the main thread (= via SAB / postMessage, sub-phase 7.3-7.5). The type is restricted to f32 / i32 / bool only (= Q42).
 */
export type StateDecl = {
  kind: "state";
  name: string;
  type: ScalarType;
  initial: number | bigint | boolean;
  snapshot?: SnapshotPolicy;
  publish?: PublishOptions;
  /**
   * Whether the user explicitly assigned a name via `.named('X')` or
   * `.expose({ name: 'X' })`. A plain factory (= `state.f32(0)`) is declared
   * with a synthetic name (= `__state_<idx>`), so `userNamed` is unset / false;
   * it becomes `true` once explicitly set in the chain. The finalize check
   * enforces "publish or snapshot 'persistent' requires a user-defined name"
   * (= rejecting the synthetic-name path as invalid). Optional so that test
   * fixtures can keep using the literal declare path.
   */
  userNamed?: boolean;
};

/**
 * `event<T>(options)` declaration (`01-dsl.md` §4.1).
 *
 * A ringbuffer-backed channel for worklet → main moment-in-time delivery. The
 * field names of `T` and their broad type family (numeric / boolean /
 * typed-array) are fixed at declaration time, while each numeric field's wire
 * type is resolved at emit-time by looking up `Node<T>` (= Q71). A per-field
 * type mismatch across multiple emit sites of a single `event<T>` handle is a
 * graph-capture-time error (= stable ID `event-field-type-mismatch`).
 *
 * `capacity` = ringbuffer slot count (= enforced at the TS level via the
 * `Capacity` literal-union, Q44), default = 256 (= `02-messaging.md` §4.1 +
 * MIDI Q4-c-i). `payloadCapacity` = content buffer bytes for variable-length
 * payloads (= `Float32Array` / `Uint8Array` fields), optional at declare time;
 * when omitted the framework derives it as "max expected payload × slot count".
 */
export type EventDeclAst = {
  kind: "event";
  name: string;
  capacity: number;
  payloadCapacity?: number;
  /**
   * Accumulates the per-field wire types resolved at emit sites (= Q71). Empty
   * right after declaration; the first emit site seals each field's wire type,
   * and subsequent emit sites are forced to use the same field names / wire
   * types. A mismatch across multiple emit sites (= same field name with a
   * differing wire type, or a differing field name) is a graph-capture-time
   * error (= stable ID `event-field-type-mismatch`).
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
 * `message<T>(options)` declaration (`01-dsl.md` §4.2).
 *
 * A ringbuffer-backed channel for main → worklet coarse-grained delivery. The
 * handler is registered at the top of each block via `onReceive(handler)` and
 * drained at the start of the quantum (= Q38-b: all handlers run per-block,
 * before forSample).
 *
 * The per-field wire types of `T` follow the Q46 uniform lift rule: every
 * number → i32 (= 4 bytes), every boolean → bool (= 4-byte u32 align),
 * typed-array → §5.2 variable-length content buffer (= filled in by a later
 * sub-phase). The payload arriving from the main side
 * `node.events.<name>.emit(p)` is plain JS = the framework wires it up and
 * dispatches the handler inside the worklet = a fully uniform path with no
 * per-field inference.
 *
 * `fields` = the field names + wire types destructured by the onReceive handler
 * (= number → i32 / boolean → bool / typed-array filled in later). Sealed by the
 * first onReceive; subsequent onReceives must use the same field names / same
 * wire types (= checked for consistency against the already-sealed set).
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
 * `type` is the element type (= `ScalarType ∪ {'u8'}`), `size` is the element
 * count (= byte size is `size × sizeof(type)`, `u8` = 1 byte). `snapshot` /
 * `publish` / `userNamed` follow the same chain semantics as state
 * (= `.named` / `.expose`; the default snapshot for buffer is `'transient'`).
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
 * Infers the result ScalarType of an expression node. Shared between the Q71
 * per-field wire-type resolution of `eventDecl.emitIf` (= `01-dsl.md` §4.1) and
 * analyze's non-f32 arithmetic detection (= `03-compiler.md` §3).
 *
 * Only accepts kinds that occupy an expression position (= statement kinds are
 * expected to have been excluded at the `unwrapAst` stage; if one does arrive,
 * it throws explicitly).
 */
export function inferAstType(ast: AstNode): ScalarType {
  switch (ast.kind) {
    // Arithmetic / math / control flow = result type is the node's `type` (= f32 path).
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
    // Comparison = result is always bool (= the node's `type` is the f32 operand type).
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
    // SIMD reduction = scalar f32 (= lane extraction / horizontal sum).
    case "vecLane":
    case "vecSumLanes":
      return "f32";
    // SIMD vec-producing = f32x4 = outside the scalar type system = invalid in scalar position.
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
