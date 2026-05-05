// AST node types for graph capture. Every primitive call during capture
// returns one of these. Values flow through the graph; statements have side
// effects (state.store, audioOut.set, buffer.write, emitIf).
//
// Types follow docs/00-foundations.md §4 (scalar tags + f32x4) and docs/01-dsl.md
// §2 (primitive operators).

export type ScalarType = "f32" | "f64" | "i32" | "i64" | "bool";
export type VecType = "f32x4";
export type AnyType = ScalarType | VecType;

export type SourceLoc = {
  file?: string;
  line?: number;
  col?: number;
};

// Common fields on every AST node value (i.e. expression).
type Base = {
  readonly id: number;
  readonly type: AnyType;
  readonly loc?: SourceLoc;
};

export type ConstScalar = Base & {
  kind: "const";
  value: number | boolean;
};

export type ParamConst = Base & {
  // A constant that is fixed for the lifetime of the processor (e.g.
  // `ctx.sampleRate`). Resolves to a constant at instantiation time.
  kind: "instance-const";
  source: "sampleRate" | "renderQuantum";
};

export type ArithOp = Base & {
  kind: "arith";
  op: "add" | "sub" | "mul" | "div" | "mod" | "neg" | "min" | "max" | "abs" | "clamp";
  args: ASTValue[];
};

export type CompareOp = Base & {
  kind: "compare";
  op: "eq" | "ne" | "lt" | "gt" | "lte" | "gte";
  a: ASTValue;
  b: ASTValue;
};

export type LogicOp = Base & {
  kind: "logic";
  op: "and" | "or" | "not";
  args: ASTValue[];
};

export type MathOp = Base & {
  kind: "math";
  op:
    | "sin"
    | "cos"
    | "tan"
    | "tanh"
    | "exp"
    | "log"
    | "sqrt"
    | "floor"
    | "ceil"
    | "frac";
  // The chosen precision implementation. Default is "default" (which the
  // codegen picks per-target). "precise" maps to JS-imported math; "table"
  // maps to lookup-table based.
  precision: "default" | "precise" | "table";
  arg: ASTValue;
};

export type SelectOp = Base & {
  kind: "select";
  cond: ASTValue;
  whenTrue: ASTValue;
  whenFalse: ASTValue;
};

export type ConvertOp = Base & {
  kind: "convert";
  // type field is the target type; from is the source.
  from: AnyType;
  arg: ASTValue;
};

// State / buffer / param read & sample-position primitives all return values.
export type StateLoad = Base & {
  kind: "state-load";
  slotId: number; // unique per processor (root scope) or per subgraph instance
};

export type BufferRead = Base & {
  kind: "buffer-read";
  bufferId: number;
  idx: ASTValue; // i32
};

export type BufferReadInterp = Base & {
  kind: "buffer-read-interp";
  bufferId: number;
  pos: ASTValue; // f32
};

export type BufferLoadVec = Base & {
  kind: "buffer-load-vec";
  bufferId: number;
  offset: ASTValue; // i32
};

export type AudioInAt = Base & {
  kind: "audio-in-at";
  inputId: number;
  channel: number; // statically known
  i: ASTValue; // i32 in scope inside forSample
};

export type ParamAt = Base & {
  kind: "param-at";
  paramId: number;
  i: ASTValue; // i32; for k-rate: must be 0
};

// SIMD: vector constructors and lane access.
export type VecCtor = Base & {
  kind: "vec-ctor";
  lanes: ASTValue[]; // 4 f32 values
};

export type VecSplat = Base & {
  kind: "vec-splat";
  arg: ASTValue;
};

export type VecLane = Base & {
  kind: "vec-lane";
  vec: ASTValue;
  lane: 0 | 1 | 2 | 3;
};

export type VecArithOp = Base & {
  kind: "vec-arith";
  op: "addVec" | "subVec" | "mulVec" | "divVec";
  a: ASTValue;
  b: ASTValue;
};

// Loop counter symbol (the `i` parameter of forSample).
export type LoopVar = Base & {
  kind: "loop-var";
  // Which forSample scope this i belongs to (depth in the loop stack).
  depth: number;
};

export type ASTValue =
  | ConstScalar
  | ParamConst
  | ArithOp
  | CompareOp
  | LogicOp
  | MathOp
  | SelectOp
  | ConvertOp
  | StateLoad
  | BufferRead
  | BufferReadInterp
  | BufferLoadVec
  | AudioInAt
  | ParamAt
  | VecCtor
  | VecSplat
  | VecLane
  | VecArithOp
  | LoopVar;

// Statements — ordered side effects.
export type StateStore = {
  kind: "state-store";
  slotId: number;
  value: ASTValue;
  loc?: SourceLoc;
};

export type BufferWrite = {
  kind: "buffer-write";
  bufferId: number;
  idx: ASTValue;
  value: ASTValue;
  loc?: SourceLoc;
};

export type BufferStoreVec = {
  kind: "buffer-store-vec";
  bufferId: number;
  offset: ASTValue;
  value: ASTValue;
  loc?: SourceLoc;
};

export type AudioOutSet = {
  kind: "audio-out-set";
  outputId: number;
  channel: number;
  i: ASTValue;
  value: ASTValue;
  loc?: SourceLoc;
};

export type EmitIf = {
  kind: "emit-if";
  eventId: number;
  cond: ASTValue;
  // Each payload field is an ASTValue (with a name + scalar type). atSample is
  // implicit and required.
  atSample: ASTValue;
  fields: Array<{ name: string; value: ASTValue; type: ScalarType }>;
  // Optional variable-length payload (Float32Array etc.) — emitted via the
  // variable-length content buffer in the wire format.
  varField?: { name: string; value: ASTValue; elemType: ScalarType };
  loc?: SourceLoc;
};

export type MidiEmitIf = {
  kind: "midi-emit-if";
  midiOutputId: number;
  cond: ASTValue;
  // Constructed MIDI event: status byte + data1 + data2 + atSample
  status: ASTValue;
  data1: ASTValue;
  data2: ASTValue;
  atSample: ASTValue;
  loc?: SourceLoc;
};

// Sub-rate execution gate: the body fires once every N samples (counter-mod).
export type EveryNSamples = {
  kind: "every-n-samples";
  N: number;
  body: Statement[];
  loc?: SourceLoc;
};

// forSample / forSample.byN body. Stride is statically known.
export type ForSampleBlock = {
  kind: "for-sample";
  stride: number;
  body: Statement[];
  loc?: SourceLoc;
};

export type Statement =
  | StateStore
  | BufferWrite
  | BufferStoreVec
  | AudioOutSet
  | EmitIf
  | MidiEmitIf
  | EveryNSamples
  | ForSampleBlock;

// Top-level captured program.
export type CapturedGraph = {
  declarations: {
    states: StateDecl[];
    buffers: BufferDecl[];
    params: ParamDecl[];
    audioInputs: AudioInputDecl[];
    audioOutputs: AudioOutputDecl[];
    events: EventDecl[];
    messages: MessageDecl[];
    midiInputs: MidiInputDecl[];
    midiOutputs: MidiOutputDecl[];
  };

  // Process body statements in source order: these include direct per-block
  // statements (state.store etc.) and ForSampleBlock invocations.
  processBody: Statement[];

  // Message handlers registered via messageDecl.onReceive.
  // Each handler has a body of statements that runs at block start when a
  // message of the given name has been received that block. Inside a handler,
  // sample-position primitives are not in scope (no `i`).
  messageHandlers: Array<{
    messageId: number;
    body: Statement[];
    payloadFields: Array<{ name: string; type: ScalarType }>;
    varField?: { name: string; elemType: ScalarType };
  }>;

  // MIDI input handlers, similar shape but keyed by event variant.
  midiHandlers: Array<{
    midiInputId: number;
    eventType:
      | "noteOn"
      | "noteOff"
      | "cc"
      | "pitchBend"
      | "programChange"
      | "channelPressure"
      | "aftertouch"
      | "systemRealtime"
      | "sysex";
    body: Statement[];
  }>;

  // Migrations (passed through to client; not WASM-emitted).
  migrations?: Array<{
    from: string;
    to: string;
    migrate: (oldBlob: Uint8Array, helpers: any) => void;
  }>;

  // Schema hash of the declarations for snapshot identity.
  schemaHash: string;
};

// ─── Declarations ────────────────────────────────────────────────────────────

export type SnapshotPolicy =
  | "persistent"
  | "transient"
  | { [profile: string]: "persistent" | "transient" };

export type StateDecl = {
  id: number;
  kind: "state";
  type: ScalarType;
  initial: number | boolean;
  name?: string;
  path: string; // slash-joined for snapshot identity
  snapshot: SnapshotPolicy;
  publish?: { rateFps: number };
};

export type BufferDecl = {
  id: number;
  kind: "buffer";
  type: ScalarType;
  size: number;
  name: string;
  path: string;
  snapshot: SnapshotPolicy;
  publish?: { rateFps: number };
};

export type ParamDecl = {
  id: number;
  kind: "param";
  name: string;
  default: number;
  min: number;
  max: number;
  automationRate: "a-rate" | "k-rate";
  unit?: string;
  snapshot: SnapshotPolicy;
};

export type AudioInputDecl = {
  id: number;
  kind: "audioInput";
  name: string;
  channels: number;
};

export type AudioOutputDecl = {
  id: number;
  kind: "audioOutput";
  name: string;
  channels: number;
};

export type EventDecl = {
  id: number;
  kind: "event";
  name: string;
  capacity: number;
  // Schema of fields (excluding atSample which is always present).
  fields: Array<{ name: string; type: ScalarType }>;
  varField?: { name: string; elemType: ScalarType; capacity?: number };
};

export type MessageDecl = {
  id: number;
  kind: "message";
  name: string;
  capacity: number;
  fields: Array<{ name: string; type: ScalarType }>;
  varField?: { name: string; elemType: ScalarType; capacity?: number };
};

export type MidiInputDecl = {
  id: number;
  kind: "midiInput";
  name: string;
  capacity: number;
};

export type MidiOutputDecl = {
  id: number;
  kind: "midiOutput";
  name: string;
  capacity: number;
};
