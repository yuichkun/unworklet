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
declare const typedArrayFieldRefBrand: unique symbol;

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
 * (`01-dsl.md` §4.3 + `decisions-log.md` Q36-b / Q84).
 *
 * Direct per-element read (`.length` / `.at()`) is offered only for the `'f32'`
 * element type (audio sample payloads). Other element types — e.g. `'u8'` byte /
 * sysex data — are transfer-only: bulk-copy them into a `buffer.<type>` slot via
 * `copyFrom` and read through the buffer (`buf.read(idx)`). The element type of a
 * `message<T>` / `event<T>` field lives only in the TS type `T`, which is erased
 * before graph capture, so the runtime cannot pick a per-element load instruction
 * for non-`f32` direct reads; the byte path is routed through the buffer primitive
 * instead (= realtime-safe `memory.copy`, Q31-c / Q49). The brand keeps the ref
 * nominal so `copyFrom` enforces element-type compatibility against its buffer.
 */
export type TypedArrayFieldRef<T extends BufferElementType> = {
  readonly [typedArrayFieldRefBrand]: T;
} & (T extends "f32"
  ? {
      readonly length: Node<"i32">;
      at(idx: Node<"i32"> | number): Node<"f32">;
    }
  : object);

/**
 * Worklet-side `eventDecl.emitIf` payload as seen at emit call site.
 *
 * Per-field wire-type resolution (Q71): the declared `T` carries field
 * **names** and a coarse type family; the precise wire type for each
 * numeric / boolean field is decided at emit time from the `Node<T>` the
 * author supplies. This mapped type lifts each scalar field to the
 * `Node<T> | T[K]` union accordingly.
 *
 * `atSample` is **optional**: when omitted, the framework supplies a
 * context-dependent default — `Node<'i32'>` loop counter inside a
 * `forSample` callback (= the per-sample `i`), `0` at per-block top
 * level. Authors override by passing `atSample` explicitly.
 */
/** `T` が typed-array field (= Float32Array / Uint8Array) を含むか。 */
type HasTypedArrayField<T> = true extends {
  [K in keyof T]: T[K] extends Float32Array | Uint8Array ? true : false;
}[keyof T]
  ? true
  : false;

export type EmitPayload<T> = {
  [K in keyof T]: T[K] extends number
    ? T[K] | Node<"f32"> | Node<"f64"> | Node<"i32"> | Node<"i64">
    : T[K] extends boolean
      ? T[K] | Node<"bool">
      : // typed-array field (§4.3 worklet→main): the content is supplied by a
        // worklet-declared `buffer.<T>` (= the single build-time-fixed construction
        // primitive, Q49); never a raw JS array. Re-emitting an inbound payload
        // copies it into a `buffer.<T>` via `copyFrom` first, then passes the
        // buffer here (Q84) — the inbound `TypedArrayFieldRef` is not accepted
        // directly, since its element type is erased and the emit path copies from
        // a buffer region.
        T[K] extends Float32Array
        ? Buffer<"f32">
        : T[K] extends Uint8Array
          ? Buffer<"u8">
          : T[K];
} & {
  atSample?: Node<"i32"> | number;
} & (HasTypedArrayField<T> extends true
    ? // framework-injected: number of elements to copy into the content buffer.
      { length: Node<"i32"> | number }
    : Record<never, never>);

export type EventDecl<T> = {
  readonly name: string;
  emitIf(cond: Node<"bool"> | boolean, payload: EmitPayload<T>): void;
};

/**
 * Worklet-side handler view of a `message<T>` payload (Q46 / Q36-b): the runtime
 * proxy delivers every field as a graph node, so the handler-side type lifts each
 * scalar field to its `Node<T>` form — `number` → `Node<'i32'>`, `boolean` →
 * `Node<'bool'>` (Q46 uniform lift) — and each variable-length typed-array field
 * to the `TypedArrayFieldRef` proxy. Lifting scalars to `Node` keeps build-time
 * JS control flow (`slot + 1`, `if (armed)`) a type error, since those would run
 * at graph capture against the proxy rather than emit DSP nodes; the DSL
 * primitives (`slot.add(1)` / `select(armed, ...)`) are the supported path. The
 * main-side send view (`node.messages.<name>(payload)`) keeps the plain JS `T`.
 */
export type MessageGraphPayload<T> = {
  [K in keyof T]: T[K] extends Float32Array
    ? TypedArrayFieldRef<"f32">
    : T[K] extends Uint8Array
      ? TypedArrayFieldRef<"u8">
      : T[K] extends boolean
        ? Node<"bool">
        : T[K] extends number
          ? Node<"i32">
          : T[K];
};

export type MessageDecl<T> = {
  readonly name: string;
  onReceive(handler: (payload: MessageGraphPayload<T>) => void): void;
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
      // Inbound handler `data` is a read-only proxy over the port's sysex content
      // (bulk-copy into a `buffer.u8` via `copyFrom`). The emit side widens this
      // to also accept a `Buffer<'u8'>` for new content (see `MidiEventEmit`).
      type: "sysex";
      data: TypedArrayFieldRef<"u8">;
      length: Node<"i32">;
      atSample: Node<"i32">;
    };

export type MidiEventType = MidiEvent["type"];

export type MidiEventGraphOf<K extends MidiEventType> = Extract<MidiEventGraph, { type: K }>;

/**
 * Emit-side `midiOutput().emitIf` event shape: every `Node<'i32'>` field of
 * `MidiEventGraph` is lifted to `Node<'i32'> | number` so authors write plain
 * literals (`channel: 0`, `atSample: 0`) per the Q33 literal-lift rule
 * (`11-midi.md` §2.2). The inbound `onEvent` handler keeps the strict
 * `MidiEventGraph` (every field is a graph node). Mirrors `EmitPayload<T>`.
 */
export type MidiEventEmit = MidiEventGraph extends infer E
  ? E extends MidiEventGraph
    ? {
        [K in keyof E]: E[K] extends Node<"i32">
          ? Node<"i32"> | number
          : // sysex emit accepts new content from a worklet `buffer.u8` as well as
            // an inbound proxy for thru (`11-midi.md` §2.5).
            E[K] extends TypedArrayFieldRef<"u8">
            ? Buffer<"u8"> | TypedArrayFieldRef<"u8">
            : E[K];
      }
    : never
  : never;

export type MidiEventEmitOf<K extends MidiEventType> = Extract<MidiEventEmit, { type: K }>;

export type MidiInputHandle = {
  readonly name: string;
  onEvent<K extends MidiEventType>(type: K, handler: (event: MidiEventGraphOf<K>) => void): void;
};

export type MidiOutputHandle = {
  readonly name: string;
  emitIf(cond: Node<"bool"> | boolean, event: MidiEventEmit): void;
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
 * publish slot metadata exposed on `WorkletNamespace.publishSlots` (= sub-phase 7.4)。
 *
 * createNode が transport mode 検 出 + SAB allocate + processorOptions に hand
 * す る 時 + worklet template が per-quantum 末 尾 で WASM memory か ら SAB に
 * copy す る 時 に 参 照。 declaration 順 = SAB 配 列 index と zip。
 *
 * - `name`: state slot name
 * - `type`: scalar type (= f32 / i32 / bool、 Q42 で 制 限 + 全 4 byte 単 一 word)
 * - `sharedOffset`: WASM memory 内 の publishShared region 内 offset (= 値 copy 元)
 * - `counterOffset`: WASM memory 内 の publishCounters region 内 offset (= 8 byte = sample counter + version counter)
 */
export type PublishSlotDescriptor = {
  readonly name: string;
  readonly type: ScalarType;
  readonly sharedOffset: number;
  readonly counterOffset: number;
};

/**
 * `event<T>` ringbuffer の per-event descriptor (= `02-messaging.md` §4 + §5.1)。
 *
 * `createNode` + worklet template が SAB allocate + copy 経 路 を 構 築 する 時 の
 * shared shape。 layout の `EventRingSlot` (= compile/layout.ts) を public surface
 * に lift し て main / worklet で 共 通 で 取 る path。
 *
 * memory map: `wasmRingBase` ~ + 12 = header `[head, tail, overflowCount]`、
 * + 12 + i × slotSize = i 番 目 slot 先 頭。 各 field の offsetInSlot / byteSize で
 * slot 内 の read / write 位 置 を 取 る。
 */
export type EventRingSlotDescriptor = {
  readonly name: string;
  readonly wasmRingBase: number;
  readonly capacity: number;
  readonly slotSize: number;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly wireType: ScalarType;
    readonly offsetInSlot: number;
    readonly byteSize: number;
    /**
     * Present when the field is a variable-length typed array (§4.3 worklet→main).
     * The slot carries `[payloadLen, payloadOffset]` at `offsetInSlot` (8 bytes);
     * the bytes live in the event's `payloadContent` region.
     */
    readonly payloadElementType?: BufferElementType;
  }>;
  /**
   * Variable-length payload content buffer for this event (§5.2), present only
   * when `T` has a typed-array field. `wasmBase` = byte offset of the content
   * region in WASM linear memory; `capacity` = its byte size. The SAB transport
   * mirrors a same-sized shared content region from `wasmBase`; the postMessage
   * transport extracts the array from `wasmBase` on the audio thread.
   */
  readonly payloadContent?: {
    readonly wasmBase: number;
    readonly capacity: number;
  };
};

/**
 * `message<T>` ringbuffer の per-message descriptor (= `02-messaging.md` §5.3)。
 *
 * event descriptor と zip pattern、 ただ し slot 内 atSample ナ シ。 main 側 が
 * SAB に push し た slot を worklet 側 で WASM memory ring に mirror し て drain
 * する path。
 *
 * memory map: `wasmRingBase` ~ + 12 = header `[head, tail, overflowCount]`、
 * + 12 + i × slotSize = i 番 目 slot 先 頭。
 */
export type MessageRingSlotDescriptor = {
  readonly name: string;
  readonly wasmRingBase: number;
  readonly capacity: number;
  readonly slotSize: number;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly wireType: ScalarType;
    readonly offsetInSlot: number;
    readonly byteSize: number;
    /**
     * Present when the field is a variable-length typed array (§5.2). The slot
     * carries `[payloadLen, payloadOffset]` at `offsetInSlot` (8 bytes); the
     * bytes live in the message's `payloadContent` region — the transport copies
     * them via the content buffer rather than inlining a scalar wire word.
     */
    readonly payloadElementType?: BufferElementType;
  }>;
  /**
   * Variable-length payload content buffer for this message (§5.2), present only
   * when `T` has a typed-array field. `wasmBase` = byte offset of the content
   * region in WASM linear memory; `capacity` = its byte size. The SAB transport
   * mirrors a same-sized shared content region onto `wasmBase`; the postMessage
   * transport writes the array bytes here directly on the audio thread.
   */
  readonly payloadContent?: {
    readonly wasmBase: number;
    readonly capacity: number;
  };
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
  publishSlots: readonly PublishSlotDescriptor[];
  eventRings: readonly EventRingSlotDescriptor[];
  messageRings: readonly MessageRingSlotDescriptor[];
  moduleUrl?: string;
  processorName?: string;
  wasmUrl?: string;
};

export type CompiledProcessor<C> = {
  readonly graph: ProcessorGraph;
  readonly schemaHash: string;
  readonly worklet: WorkletNamespace;
  /**
   * Declarative schema-migration chain from the processor's options bag
   * (`01-dsl.md` §8.3). Carried on the compiled artifact so `restore` /
   * `replaceProcessor` can bridge an older blob to the current schema. Omitted
   * when the processor declares no migrations.
   */
  readonly migrations?: readonly Migration[];
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
 * `compile(processor, options)` 第 2 引 数 (= sub-phase 7.3 で 追 加)。
 *
 * - `sampleRate`: build-time 既 知 と し て emit に hand (= publish scheduler の
 *   threshold = `Math.round(sampleRate / rateFps)` を const fold)。 default
 *   = 48000 (= 既 test fixture / host 既 定 と zip)。 1 wasm = 1 sampleRate =
 *   別 sampleRate な ら 別 wasm を emit。
 */
export type CompileOptions = {
  sampleRate?: number;
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
  | { code: "block-length-mismatch"; expected: number; received: number }
  /**
   * Path β escape hatch (= `01-dsl.md` §11): an author writing a custom
   * `class extends AudioWorkletProcessor` forgot to call
   * `def.worklet.initialize(this, opts)` in their constructor, so
   * `def.worklet.process(this, ...)` runs without any WASM state attached
   * to `self`。 The audio thread cannot throw (= `00-foundations.md` §5.1
   * invariant 3), so the runtime posts this once and then continues
   * emitting silence。 Compile-time check is impossible (= the custom
   * class lives in user code), so this is the runtime fail-fast signal。
   */
  | { code: "worklet-initialize-not-called" };

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
  /**
   * Per-`audioInput` AudioNode destinations。 Users write
   * `source.connect(node.inputs.main)` and the framework internally routes
   * to the correct input port index of the underlying `AudioWorkletNode`
   * (= Q6 + canonical Ex 1 / 2)。 Each handle is an `AudioNode`、 so all of
   * `AudioNode.connect(...)` / `disconnect(...)` overloads work natively。
   */
  readonly inputs: Record<string, AudioNode>;
  readonly outputs: Record<
    string,
    { connect(target: AudioNode | AudioParam): void; disconnect(): void }
  >;
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
