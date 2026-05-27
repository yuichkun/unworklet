/**
 * Public type declarations for `@unworklet/core`.
 *
 * Authoritative spec references:
 * - `docs/00-foundations.md` §3 vocabulary / §4 type system
 * - `docs/01-dsl.md` §1 / §3 / §4 / §10 surface
 * - `docs/02-messaging.md` §1 / §5
 * - `docs/04-worklet-runtime.md` §8 error events
 * - `docs/05-client.md` §1 / §2 / §6 / §8 main-side surface
 * - `docs/11-midi.md` §2 MIDI surface
 * - `docs/09-repo-structure.md` §2.1 public exports
 *
 * Concrete TS generic constraint shape and method-form expansion on
 * `Node<T>` are impl-phase fill — this file declares the type surface
 * that all stub modules and external consumers compile against.
 */

import type {
  CAPACITY_16,
  CAPACITY_32,
  CAPACITY_64,
  CAPACITY_128,
  CAPACITY_256,
  CAPACITY_512,
  CAPACITY_1024,
  CAPACITY_2048,
  CAPACITY_4096,
  CAPACITY_8192,
  CAPACITY_16384,
} from "./dsl/constants.ts";

// ─────────────────────────────────────────────────────────────────────────
// Scalar / capacity tags
// ─────────────────────────────────────────────────────────────────────────

/** Scalar tag set carried by `Node<T>` and value-handle generics. */
export type ScalarType = "f32" | "f64" | "i32" | "i64" | "bool";

/** Element-type tag set for `Buffer<T>` (= `ScalarType ∪ {'u8'}`). */
export type BufferElementType = ScalarType | "u8";

/** Ringbuffer capacity literal-union, see `02-messaging.md` §3 + Q44. */
export type Capacity =
  | typeof CAPACITY_16
  | typeof CAPACITY_32
  | typeof CAPACITY_64
  | typeof CAPACITY_128
  | typeof CAPACITY_256
  | typeof CAPACITY_512
  | typeof CAPACITY_1024
  | typeof CAPACITY_2048
  | typeof CAPACITY_4096
  | typeof CAPACITY_8192
  | typeof CAPACITY_16384;

/** Maps `ScalarType` to its plain JS counterpart (= used by `MigrationHelpers`). */
export type ScalarOf<T extends ScalarType> = T extends "bool"
  ? boolean
  : T extends "i64"
    ? bigint
    : number;

/** Maps `ScalarType` to its typed-array counterpart (= used by `MigrationHelpers` / `buffer.publish`). */
export type TypedArrayOf<T extends BufferElementType> = T extends "f32"
  ? Float32Array
  : T extends "f64"
    ? Float64Array
    : T extends "i32"
      ? Int32Array
      : T extends "i64"
        ? BigInt64Array
        : T extends "bool" | "u8"
          ? Uint8Array
          : never;

// ─────────────────────────────────────────────────────────────────────────
// Branded value handles
// ─────────────────────────────────────────────────────────────────────────

declare const nodeBrand: unique symbol;
declare const stateBrand: unique symbol;
declare const bufferBrand: unique symbol;
declare const paramBrand: unique symbol;

/**
 * `Node<T>` — handle to a value computed during graph capture.
 *
 * Declared as an `interface` so that `./dsl/primitives.ts` and
 * `./simd.ts` can extend it via declaration merging to add the Q77
 * hybrid chain methods (arithmetic / comparison / math) and the SIMD
 * vec methods. This declaration carries the brand only.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Node<T extends ScalarType | "f32x4" = ScalarType> {
  readonly [nodeBrand]: T;
}

/** Scalar `state.<type>(initial)` handle (`01-dsl.md` §3.1). */
export type State<T extends ScalarType> = {
  readonly [stateBrand]: T;
  load(): Node<T>;
  store(v: Node<T> | ScalarOf<T>): void;
  named(name: string): State<T>;
  expose(options: ExposeOptions): State<T>;
};

/** Fixed-size `buffer.<type>({ size })` handle (`01-dsl.md` §3.2). */
export interface Buffer<T extends BufferElementType> {
  readonly [bufferBrand]: T;
  readonly size: number;
  readonly name: string;
  read(idx: Node<"i32"> | number): Node<T extends "u8" ? "i32" : Extract<T, ScalarType>>;
  write(
    idx: Node<"i32"> | number,
    v: Node<T extends "u8" ? "i32" : Extract<T, ScalarType>> | number,
  ): void;
  readInterpolated(
    pos: Node<"f32"> | number,
  ): Node<T extends "u8" ? "i32" : Extract<T, ScalarType>>;
  copyFrom(src: TypedArrayFieldRef<T>): void;
  named(name: string): Buffer<T>;
  expose(options: ExposeOptions): Buffer<T>;
}

/** AudioParam-backed `param.f32(...)` handle (`01-dsl.md` §3.3). */
export type Param = {
  readonly [paramBrand]: "f32";
  at(i: Node<"i32"> | number): Node<"f32">;
  named(name: string): Param;
  expose(options: ExposeOptions): Param;
};

// ─────────────────────────────────────────────────────────────────────────
// Slot exposure options (`01-dsl.md` §3.1 / §3.2 / §3.3 + Q79)
// ─────────────────────────────────────────────────────────────────────────

export type SnapshotPolicy =
  | "persistent"
  | "transient"
  | Record<string, "persistent" | "transient">;

export type PublishOptions = {
  rateFps: number;
};

export type ExposeOptions = {
  name?: string;
  snapshot?: SnapshotPolicy;
  publish?: PublishOptions;
};

// ─────────────────────────────────────────────────────────────────────────
// Audio I/O (`01-dsl.md` §1.1 / §1.2 / §1.3)
// ─────────────────────────────────────────────────────────────────────────

/** Tuple-derived `0 | 1 | … | C - 1`. Stub = brand-tagged `number`; refined in impl phase. */
export type ChannelIndex<C extends number> = number & { readonly __channel?: C };

export type InputChannelView<T extends ScalarType> = {
  at(i: Node<"i32"> | number): Node<T>;
};

export type OutputChannelSample<T extends ScalarType> = {
  write(v: Node<T> | number): void;
};

export type OutputChannelView<T extends ScalarType> = {
  at(i: Node<"i32"> | number): OutputChannelSample<T>;
};

type StereoInputSugar = {
  readonly left: InputChannelView<"f32">;
  readonly right: InputChannelView<"f32">;
};

type StereoOutputSugar = {
  readonly left: OutputChannelView<"f32">;
  readonly right: OutputChannelView<"f32">;
};

export type AudioInputHandle<C extends number> = {
  readonly channels: C;
  readonly name: string;
  ch(c: ChannelIndex<C> | number): InputChannelView<"f32">;
} & (C extends 2 ? StereoInputSugar : object);

export type AudioOutputHandle<C extends number> = {
  readonly channels: C;
  readonly name: string;
  ch(c: ChannelIndex<C> | number): OutputChannelView<"f32">;
} & (C extends 2 ? StereoOutputSugar : object);

// ─────────────────────────────────────────────────────────────────────────
// Messaging surface (`01-dsl.md` §4 + `02-messaging.md`)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Variable-length typed-array field proxy in handler-context payloads
 * (`01-dsl.md` §4.3 + `decisions-log.md` Q36-b).
 */
export type TypedArrayFieldRef<T extends BufferElementType> = {
  readonly length: Node<"i32">;
  at(idx: Node<"i32"> | number): Node<T extends "u8" ? "i32" : Extract<T, ScalarType>>;
};

/**
 * Worklet-side `eventDecl.emitIf` payload as seen at emit call site.
 *
 * Per-field wire-type resolution (Q71): the declared `T` carries field
 * **names** and a coarse type family; the precise wire type for each
 * numeric / boolean field is decided at emit time from the `Node<T>` the
 * author supplies. This mapped type lifts each scalar field to the
 * `Node<T> | T[K]` union accordingly.
 */
export type EmitPayload<T> = {
  [K in keyof T]: T[K] extends number
    ? T[K] | Node<"f32"> | Node<"f64"> | Node<"i32"> | Node<"i64">
    : T[K] extends boolean
      ? T[K] | Node<"bool">
      : T[K];
} & {
  atSample: Node<"i32"> | number;
};

export type EventDecl<T> = {
  readonly name: string;
  emitIf(cond: Node<"bool"> | boolean, payload: EmitPayload<T>): void;
};

export type MessageDecl<T> = {
  readonly name: string;
  onReceive(handler: (payload: T) => void): void;
};

// ─────────────────────────────────────────────────────────────────────────
// MIDI surface (`11-midi.md`)
// ─────────────────────────────────────────────────────────────────────────

/** Main-thread `MidiEvent` discriminated union (plain JS scalars). */
export type MidiEvent =
  | { type: "noteOn"; channel: number; note: number; velocity: number }
  | { type: "noteOff"; channel: number; note: number; velocity: number }
  | { type: "cc"; channel: number; controller: number; value: number }
  | { type: "pitchBend"; channel: number; value: number }
  | { type: "programChange"; channel: number; program: number }
  | { type: "channelPressure"; channel: number; pressure: number }
  | { type: "aftertouch"; channel: number; note: number; pressure: number }
  | { type: "systemRealtime"; status: number }
  | { type: "sysex"; data: Uint8Array };

/** Worklet audio-thread `MidiEventGraph` discriminated union (graph-capture nodes). */
export type MidiEventGraph =
  | {
      type: "noteOn";
      channel: Node<"i32">;
      note: Node<"i32">;
      velocity: Node<"i32">;
      atSample: Node<"i32">;
    }
  | {
      type: "noteOff";
      channel: Node<"i32">;
      note: Node<"i32">;
      velocity: Node<"i32">;
      atSample: Node<"i32">;
    }
  | {
      type: "cc";
      channel: Node<"i32">;
      controller: Node<"i32">;
      value: Node<"i32">;
      atSample: Node<"i32">;
    }
  | { type: "pitchBend"; channel: Node<"i32">; value: Node<"i32">; atSample: Node<"i32"> }
  | { type: "programChange"; channel: Node<"i32">; program: Node<"i32">; atSample: Node<"i32"> }
  | { type: "channelPressure"; channel: Node<"i32">; pressure: Node<"i32">; atSample: Node<"i32"> }
  | {
      type: "aftertouch";
      channel: Node<"i32">;
      note: Node<"i32">;
      pressure: Node<"i32">;
      atSample: Node<"i32">;
    }
  | { type: "systemRealtime"; status: Node<"i32">; atSample: Node<"i32"> }
  | {
      type: "sysex";
      data: Buffer<"u8"> | TypedArrayFieldRef<"u8">;
      length: Node<"i32">;
      atSample: Node<"i32">;
    };

export type MidiEventType = MidiEvent["type"];

export type MidiEventGraphOf<K extends MidiEventType> = Extract<MidiEventGraph, { type: K }>;

export type MidiInputHandle = {
  readonly name: string;
  onEvent<K extends MidiEventType>(type: K, handler: (event: MidiEventGraphOf<K>) => void): void;
};

export type MidiOutputHandle = {
  readonly name: string;
  emitIf(cond: Node<"bool"> | boolean, event: MidiEventGraph): void;
};

// ─────────────────────────────────────────────────────────────────────────
// Processor lifecycle (`01-dsl.md` §1 / §8 + `05-client.md` §1)
// ─────────────────────────────────────────────────────────────────────────

/** Compile-time context passed to `defineProcessor` / `defineSubgraph` bodies. */
export type ProcessorContext = {
  readonly sampleRate: number;
};

/** Strict shape returned by `defineProcessor` / `defineSubgraph` bodies. */
export type ProcessorBody = {
  process: () => void;
};

/**
 * Opaque graph capture result. Internal AST DAG shape is impl-phase fill;
 * consumers treat values as opaque tokens passed to `compile` / `createNode`.
 */
export type ProcessorGraph = {
  readonly __processorGraph: unique symbol;
};

/**
 * Audio I/O port metadata exposed on `WorkletNamespace.inputs` /
 * `WorkletNamespace.outputs` (= declaration order に 対応、 port index は
 * 配列 index と 同じ)。
 */
export type AudioPortDescriptor = {
  readonly name: string;
  readonly channels: number;
};

/**
 * Worklet escape-hatch namespace exposed on `CompiledProcessor<C>.worklet`
 * (`01-dsl.md` §11 + Q80).
 *
 * `initialize` / `process` / `parameterDescriptors` + `inputs` / `outputs`
 * are always present — filled by `makeWorkletNamespace(graph)` at
 * `defineProcessor` time.
 *
 * `moduleUrl` / `processorName` / `wasmUrl` appear only on processors
 * imported via `@unworklet/vite-plugin`'s `?worklet` virtual module (or
 * an equivalent live-coding helper that populates the same fields)。
 * `createNode` reads them to wire `audioWorklet.addModule(...)` +
 * `new AudioWorkletNode(...)`.
 */
export type WorkletNamespace = {
  initialize: (...args: unknown[]) => void;
  process: (...args: unknown[]) => boolean;
  parameterDescriptors: readonly unknown[];
  inputs: readonly AudioPortDescriptor[];
  outputs: readonly AudioPortDescriptor[];
  moduleUrl?: string;
  processorName?: string;
  wasmUrl?: string;
};

export type CompiledProcessor<C> = {
  readonly graph: ProcessorGraph;
  readonly schemaHash: string;
  readonly worklet: WorkletNamespace;
  readonly __compiledProcessor: C;
};

export type Migration = {
  from: string;
  to: string;
  migrate: (blob: Uint8Array, helpers: MigrationHelpers) => void | Promise<void>;
};

export type MigrationHelpers = {
  parseSlot<T extends ScalarType>(blob: Uint8Array, name: string, type: T): ScalarOf<T> | undefined;
  parseBuffer<T extends BufferElementType>(
    blob: Uint8Array,
    name: string,
    type: T,
  ): TypedArrayOf<T> | undefined;
  parseParam(blob: Uint8Array, name: string): number | undefined;
  parseSlotInProfile<T extends ScalarType>(
    blob: Uint8Array,
    name: string,
    type: T,
    profile: string,
  ): ScalarOf<T> | undefined;
  writeSlot<T extends ScalarType>(name: string, type: T, value: ScalarOf<T>): void;
  writeBuffer<T extends BufferElementType>(name: string, type: T, data: TypedArrayOf<T>): void;
  writeParam(name: string, value: number): void;
  writeSlotInProfile<T extends ScalarType>(
    name: string,
    type: T,
    value: ScalarOf<T>,
    profile: string,
  ): void;
  readonly oldSchemaHash: string;
  readonly oldProfileName: string | null;
};

export type ProcessorOptions = {
  migrations?: Migration[];
  migrationsStrict?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────
// Compile API (`03-compiler.md` §1)
// ─────────────────────────────────────────────────────────────────────────

export type GraphJson = {
  readonly __graphJson: unique symbol;
};
export type MemoryJson = {
  readonly __memoryJson: unique symbol;
};
export type DiagnosticsJson = {
  readonly __diagnosticsJson: unique symbol;
};

export type CompileResult<C> = {
  wasm: Uint8Array;
  graph: GraphJson;
  memory: MemoryJson;
  diagnostics: DiagnosticsJson;
  schemaHash: string;
  driver: CompileDriver;
  __compiledProcessor: C;
};

/**
 * Driver-friendly handle exposed on `CompileResult.driver`。 internal
 * layout / graph を 隠 蔽 し て、 `renderOffline` / Phase 6 worklet
 * template が memory I/O + process() を 駆 動 す る ため の 公 開 surface。
 * lazy = `instantiate()` を 呼 ぶ と 初 め て WebAssembly.compile +
 * instantiate を 実 行 (= 1 wasm を 複 数 instance で 走 ら せ る 用 途
 * 担 保)。
 */
export type CompileDriver = {
  instantiate(): Promise<CompileInstance>;
};

export type CompileInstance = {
  readonly memory: WebAssembly.Memory;
  process(): void;
  readonly declarations: ReadonlyArray<CompileInstanceDeclaration>;
  /** Caller invariant: `blockData.length === SAMPLES_PER_BLOCK`。 */
  writeInput(portName: string, channel: number, blockData: Float32Array): void;
  /** Caller invariant: `blockData.length === SAMPLES_PER_BLOCK`。 */
  writeParam(paramName: string, blockData: Float32Array): void;
  /** Caller invariant: `dest.length === SAMPLES_PER_BLOCK`。 */
  readOutput(portName: string, channel: number, dest: Float32Array): void;
};

export type CompileInstanceDeclaration =
  | { readonly kind: "audioInput"; readonly name: string; readonly channels: number }
  | { readonly kind: "audioOutput"; readonly name: string; readonly channels: number }
  | { readonly kind: "param"; readonly name: string; readonly default: number };

// ─────────────────────────────────────────────────────────────────────────
// Main-side surface (`05-client.md` §2 / §2.6 / §8)
// ─────────────────────────────────────────────────────────────────────────

export type CreateNodeOptions<C> = {
  initial?: Partial<Record<string, number>>;
  __processor?: C;
};

export type NodeErrorEvent =
  | { code: "wasm-trap"; message: string }
  | { code: "queue-overflow"; source: "event" | "message" | "midi"; name: string; dropped: number }
  | { code: "sab-unavailable" }
  | { code: "block-length-mismatch"; expected: number; received: number };

export type TransportMode = "sab" | "postMessage";

export type StateValueProxy<V> = {
  readonly value: V;
  subscribe(handler: (value: V) => void): () => void;
};

export type BufferValueProxy<V> = {
  readonly value: V;
  subscribe(handler: (value: V) => void): () => void;
};

export type EventSubscriber<T> = {
  on(handler: (payload: T & { atSample: number }) => void): () => void;
  readonly diagnostics: {
    overflowCount(): number;
  };
};

export type MessageSender<T> = ((payload: T) => void) & {
  readonly diagnostics: {
    overflowCount(): number;
  };
};

export type MidiPortSurface = {
  send(event: MidiEvent, atTime?: number): void;
  connectFromWebMIDI(input: unknown): void;
  onEvent<K extends MidiEventType>(
    type: K,
    handler: (event: Extract<MidiEvent, { type: K }>) => void,
  ): () => void;
  readonly diagnostics: {
    overflowCount(): number;
  };
};

export type UnworkletNode<C> = {
  readonly node: AudioWorkletNode;
  readonly inputs: Record<string, { connect(target: unknown): void; disconnect(): void }>;
  readonly outputs: Record<string, { connect(target: unknown): void; disconnect(): void }>;
  readonly params: Record<string, AudioParam>;
  readonly state: Record<string, StateValueProxy<unknown> | BufferValueProxy<unknown>>;
  readonly events: Record<string, EventSubscriber<unknown>>;
  readonly messages: Record<string, MessageSender<unknown>>;
  readonly midi: Record<string, MidiPortSurface>;
  readonly diagnostics: { readonly transport: TransportMode };
  snapshot(options?: { profile?: string }): Promise<Uint8Array>;
  restore(blob: Uint8Array): Promise<RestoreResult>;
  dispose(): void;
  onError(handler: (event: NodeErrorEvent) => void): () => void;
  readonly __processor: C;
};

// ─────────────────────────────────────────────────────────────────────────
// Snapshot / restore / inspect (`05-client.md` §2.6 + `01-dsl.md` §8)
// ─────────────────────────────────────────────────────────────────────────

export type RestoreOk = {
  ok: true;
  applied: string[];
  restored: number;
  skipped: string[];
  missing: string[];
};

export type RestoreFailure = {
  ok: false;
  error: { step: string; message: string; cause: unknown };
  applied: string[];
  restored: number;
  skipped: string[];
  missing: string[];
};

export type RestoreResult = RestoreOk | RestoreFailure;

export type ReplaceResult<New> = (RestoreOk | RestoreFailure) & {
  node: UnworkletNode<New>;
};

export type SlotInspection =
  | { kind: "state"; type: ScalarType; value: number | boolean }
  | { kind: "param"; value: number }
  | { kind: "buffer"; type: BufferElementType; length: number; head: number[] };

export type InspectionResult = {
  version: number;
  schemaHash: string;
  profile: string | null;
  slots: Record<string, SlotInspection>;
};
