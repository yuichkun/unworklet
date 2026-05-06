export type ScalarType = "f32" | "f64" | "i32" | "i64" | "bool";
export type VecType = "f32x4";
export type AnyType = ScalarType | VecType;

declare const NodeBrand: unique symbol;
export type Node<T extends AnyType> = number & { readonly [NodeBrand]: T };

export type ChannelIndex<C extends number> = C extends 1
  ? 0
  : C extends 2
    ? 0 | 1
    : C extends 3
      ? 0 | 1 | 2
      : C extends 4
        ? 0 | 1 | 2 | 3
        : number;

export type State<T extends ScalarType> = {
  load(): Node<T>;
  store(v: Node<T> | number | boolean): void;
  __isState: true;
  __type: T;
  __name?: string;
};

export type Buffer<T extends ScalarType> = {
  read(idx: Node<"i32"> | number): Node<T>;
  write(idx: Node<"i32"> | number, v: Node<T> | number): void;
  readInterpolated(pos: Node<"f32"> | number): Node<T>;
  loadVec(offset: Node<"i32"> | number): Node<"f32x4">;
  storeVec(offset: Node<"i32"> | number, value: Node<"f32x4">): void;
  size: number;
  name: string;
  __isBuffer: true;
  __type: T;
};

export type ParamHandle = {
  at(i: Node<"i32"> | number): Node<"f32">;
  __isParam: true;
  __name: string;
};

export type AudioInputHandle<C extends number> = {
  at(c: ChannelIndex<C>, i: Node<"i32"> | number): Node<"f32">;
  channels: C;
  name: string;
  __isAudioInput: true;
};

export type AudioOutputHandle<C extends number> = {
  set(c: ChannelIndex<C>, i: Node<"i32"> | number, v: Node<"f32"> | number): void;
  channels: C;
  name: string;
  __isAudioOutput: true;
};

export type SnapshotPolicy =
  | "persistent"
  | "transient"
  | { [profile: string]: "persistent" | "transient" };

// Stable serialization of a SnapshotPolicy. Used by both the compiler's
// schema-hash computation (capture.ts) and the engine's (engine.ts) so
// they produce identical hashes — without this, record-form policies
// stringify as "[object Object]" and silently break migration matching.
export function policyKey(p: SnapshotPolicy | undefined): string {
  if (!p) return "persistent";
  if (typeof p === "string") return p;
  return Object.entries(p)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

export type PublishOptions = { rateFps: number };

export type StateOptions<T extends ScalarType> = {
  name?: string;
  snapshot?: SnapshotPolicy;
  publish?: PublishOptions;
};

export type BufferOptions<T extends ScalarType> = {
  size: number;
  name: string;
  snapshot?: SnapshotPolicy;
  publish?: PublishOptions;
};

export type ParamOptions = {
  default: number;
  min: number;
  max: number;
  automationRate: "a-rate" | "k-rate";
  unit?: string;
  name: string;
  snapshot?: SnapshotPolicy;
};

export type AudioInputOptions<C extends number> = {
  channels: C;
  name: string;
};

export type AudioOutputOptions<C extends number> = {
  channels: C;
  name: string;
};

export type EventDecl<T> = {
  emitIf(cond: Node<"bool"> | boolean, payload: T & { atSample: number | Node<"i32"> }): void;
  __isEvent: true;
  __name: string;
};

export type MessageDecl<T> = {
  onReceive(handler: (payload: T) => void): void;
  __isMessage: true;
  __name: string;
};

export type EventOptions = {
  name: string;
  capacity?: number;
  // Reserved for future variable-length event payloads (per docs/01-dsl §4.3 +
  // 02-messaging §5.2). v1.0.0 only ships variable-length payloads on the
  // message<T> direction (see message({ payload })); event<T> v.l. is queued
  // behind a roadmap item and accepting this option here is a no-op rather
  // than a silent failure mode. v1.x.0 will plumb it through memory-layout.
  payloadCapacity?: number;
};

export type MessageOptions = {
  name: string;
  capacity?: number;
};

// MIDI

export type MidiEvent =
  | { type: "noteOn"; channel: number; note: number; velocity: number; atSample: number }
  | { type: "noteOff"; channel: number; note: number; velocity: number; atSample: number }
  | { type: "cc"; channel: number; controller: number; value: number; atSample: number }
  | { type: "pitchBend"; channel: number; value: number; atSample: number }
  | { type: "programChange"; channel: number; program: number; atSample: number }
  | { type: "channelPressure"; channel: number; pressure: number; atSample: number }
  | { type: "aftertouch"; channel: number; note: number; pressure: number; atSample: number }
  | { type: "systemRealtime"; status: number; atSample: number }
  | { type: "sysex"; data: Uint8Array; atSample: number };

export type MidiEventByType<K extends MidiEvent["type"]> = Extract<MidiEvent, { type: K }>;

export type MidiInputHandle = {
  onEvent<K extends MidiEvent["type"]>(type: K, handler: (e: MidiEventByType<K>) => void): void;
  __isMidiInput: true;
  __name: string;
};

export type MidiOutputHandle = {
  emitIf(cond: Node<"bool"> | boolean, event: MidiEvent): void;
  __isMidiOutput: true;
  __name: string;
};

export type MidiOptions = {
  name?: string;
  capacity?: number;
};

export type MigrationHelpers = {
  parseSlot<T extends ScalarType>(
    blob: Uint8Array,
    name: string,
    type: T,
  ): number | boolean | undefined;
  parseBuffer<T extends ScalarType>(
    blob: Uint8Array,
    name: string,
    type: T,
  ): Float32Array | Int32Array | undefined;
  parseParam(blob: Uint8Array, name: string): number | undefined;
  parseSlotInProfile<T extends ScalarType>(
    blob: Uint8Array,
    name: string,
    type: T,
    profile: string,
  ): number | boolean | undefined;
  writeSlot<T extends ScalarType>(name: string, type: T, value: number | boolean): void;
  writeBuffer<T extends ScalarType>(name: string, type: T, data: Float32Array | Int32Array): void;
  writeParam(name: string, value: number): void;
  writeSlotInProfile<T extends ScalarType>(
    name: string,
    type: T,
    value: number | boolean,
    profile: string,
  ): void;
  oldSchemaHash: string;
  oldProfileName: string | null;
};

export type Migration = {
  from: string;
  to: string;
  migrate: (oldBlob: Uint8Array, helpers: MigrationHelpers) => void;
};

export type ProcessorOptions = {
  migrations?: Migration[];
  migrationsStrict?: boolean;
};

export type ProcessorContext = {
  sampleRate: number;
  renderQuantum: number;
};

export type ProcessReturn = {
  process: () => void;
};

export type ProcessorBody = (ctx: ProcessorContext) => ProcessReturn;

export type CompiledProcessor = {
  __isCompiledProcessor: true;
  body: ProcessorBody;
  options?: ProcessorOptions;
};
