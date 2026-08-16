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
 * `Node<T>` live in the impl modules (`dsl/primitives.ts` and others) — this
 * file declares the type surface that all modules and external consumers
 * compile against.
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
/**
 * Method-form type helpers (Q77 hybrid): each restricts a chain method to the
 * scalar types it has a meaningful lowering for, typing the member `never`
 * elsewhere so the call site fails to compile (`bool(true).add(1)` /
 * `i32(1).sin()` are errors). These are declared with the `Node` interface — not
 * as a cross-file `declare module` augmentation — so the method surface survives
 * dts bundling into the published `dist/*.d.mts`. The runtime impl lives in
 * `dsl/primitives.ts` / `dsl/pipe.ts` (attached via `registerNodeMethod`).
 */
type NumericScalar = "f32" | "f64" | "i32" | "i64";
type FloatMethod<T> = T extends "f32" | "f64" ? () => Node<T> : never;
type NumericVecBinary<T> = T extends NumericScalar | "f32x4"
  ? (other: Node<T> | number) => Node<T>
  : never;
type NumericBinary<T> = T extends NumericScalar ? (other: Node<T> | number) => Node<T> : never;
type NumericUnary<T> = T extends NumericScalar ? () => Node<T> : never;
type NumericClamp<T> = T extends NumericScalar
  ? (lo: Node<T> | number, hi: Node<T> | number) => Node<T>
  : never;
type NumericCompare<T> = T extends NumericScalar
  ? (other: Node<T> | number) => Node<"bool">
  : never;
type BoolUnary<T> = T extends "bool" ? () => Node<"bool"> : never;
type BoolBinary<T> = T extends "bool" ? (other: Node<"bool"> | boolean) => Node<"bool"> : never;

export interface Node<T extends ScalarType | "f32x4" = ScalarType> {
  readonly [nodeBrand]: T;
  // Arithmetic (numeric scalars; add/sub/mul/div also lower for SIMD f32x4).
  // `bool` is excluded — `bool(true).add(1)` would emit f32 ops on an i32 operand.
  add: NumericVecBinary<T>;
  sub: NumericVecBinary<T>;
  mul: NumericVecBinary<T>;
  div: NumericVecBinary<T>;
  mod: NumericBinary<T>;
  neg: NumericUnary<T>;
  // Comparison (numeric operands, `Node<'bool'>` result; bool / f32x4 excluded).
  eq: NumericCompare<T>;
  lt: NumericCompare<T>;
  gt: NumericCompare<T>;
  lte: NumericCompare<T>;
  gte: NumericCompare<T>;
  // Logical negation (bool only; `not()` on a numeric `Node` is a type error).
  not: BoolUnary<T>;
  // Logical binary (bool only; `and(a, b)` / `or(a, b)` free-function form
  // symmetric to `not`, method form for chaining. Both operands evaluated —
  // no short-circuit in WASM realtime. `select(cond, a, b)` does NOT help: it
  // chooses a value, it does not guard evaluation, so an unchosen
  // `noiseSource.next()` still advances and an unchosen i32 divide still traps.
  // Restructure so every operand is safe to evaluate instead.).
  and: BoolBinary<T>;
  or: BoolBinary<T>;
  // Math — `sqrt` / `floor` / `ceil` / `frac` / transcendentals are float-only;
  // `abs` is meaningful for every numeric scalar (lowered to `select(x<0,-x,x)`).
  sin: FloatMethod<T>;
  cos: FloatMethod<T>;
  tan: FloatMethod<T>;
  tanh: FloatMethod<T>;
  exp: FloatMethod<T>;
  log: FloatMethod<T>;
  sqrt: FloatMethod<T>;
  floor: FloatMethod<T>;
  ceil: FloatMethod<T>;
  frac: FloatMethod<T>;
  abs: NumericUnary<T>;
  min: NumericBinary<T>;
  max: NumericBinary<T>;
  clamp: NumericClamp<T>;
  /** Thread this node through `fn`: `x.pipe(f)` ≡ `f(x)`. */
  pipe<U extends ScalarType | "f32x4">(fn: (x: Node<T>) => Node<U>): Node<U>;
  /**
   * SIMD lane access (opt-in `@unworklet/core/simd`): resolves to a value only on
   * a `Node<'f32x4'>`, which only the simd surface (`vec4` / `splat` / …) can
   * produce, so it is `never` for every scalar `Node`. Declared here (not via a
   * `@unworklet/core/simd` augmentation) so it survives dts bundling.
   */
  lane: T extends "f32x4" ? (i: 0 | 1 | 2 | 3) => Node<"f32"> : never;
}

/** Scalar `state.<type>(initial)` handle (`01-dsl.md` §3.1). */
export type State<T extends ScalarType> = {
  readonly [stateBrand]: T;
  read(): Node<T>;
  write(v: Node<T> | ScalarOf<T>): void;
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
  /**
   * SIMD buffer I/O: load / store four contiguous f32 lanes (element-units
   * offset). Real only for `Buffer<'f32'>`, `never` otherwise. The runtime lives
   * in core (every buffer carries it); declared here (not via a
   * `@unworklet/core/simd` augmentation) so it survives dts bundling.
   */
  loadVec: T extends "f32" ? (offset: Node<"i32"> | number) => Node<"f32x4"> : never;
  storeVec: T extends "f32" ? (offset: Node<"i32"> | number, value: Node<"f32x4">) => void : never;
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
// Noise source (`01-dsl.md` §2 stateful sources)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for `noiseSource(...)`.
 */
export type NoiseSourceOptions = {
  /**
   * Compile-time integer seed for the internal xorshift32 PRNG. Omitted →
   * framework auto-assigns per declaration order (1, 2, 3, …). Explicit seeds
   * pin the noise output byte-for-byte across code edits, which is what golden
   * snapshot tests and preset restoration rely on. `seed === 0` is silently
   * substituted with a sentinel constant because xorshift32 locks at zero.
   */
  seed?: number;
};

/**
 * A declared noise source with a private i32 PRNG state slot. Returned by
 * `noiseSource(...)`. Each `.next()` call advances the internal state one step
 * (xorshift32) and returns the next `[-1, 1)` sample, so **call count = PRNG
 * consumption**. To use the same sample in multiple places within one
 * iteration, hold it once: `const s = src.next()` then reuse `s`.
 */
export type NoiseSource = {
  next(): Node<"f32">;
};

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
/** Whether `T` contains a typed-array field (= `Float32Array` / `Uint8Array`). */
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
 * scalar field to its `Node<T>` form — `number` → `Node<'f32'>`, `boolean` →
 * `Node<'bool'>` (the inbound number wire is f32 so fractions survive) — and each
 * variable-length typed-array field
 * to the `TypedArrayFieldRef` proxy. Lifting scalars to `Node` keeps build-time
 * JS control flow (`slot + 1`, `if (armed)`) a type error, since those would run
 * at graph capture against the proxy rather than emit DSP nodes; the DSL
 * primitives (`slot.add(1)` / `select(armed, ...)`) are the supported path. The
 * main-side send view (`node.events.<name>.emit(payload)`) keeps the plain JS `T`.
 */
export type MessageGraphPayload<T> = {
  [K in keyof T]: T[K] extends Float32Array
    ? TypedArrayFieldRef<"f32">
    : T[K] extends Uint8Array
      ? TypedArrayFieldRef<"u8">
      : T[K] extends boolean
        ? Node<"bool">
        : T[K] extends number
          ? Node<"f32">
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
 * `WorkletNamespace.outputs` (= follows declaration order; the port index is
 * the array index).
 */
export type AudioPortDescriptor = {
  readonly name: string;
  readonly channels: number;
};

/**
 * publish slot metadata exposed on `WorkletNamespace.publishSlots` (= sub-phase 7.4).
 *
 * Referenced by `createNode` when it detects the transport mode, allocates the
 * SAB, and hands it to `processorOptions`, and by the worklet template when it
 * copies from WASM memory to the SAB at the end of each quantum. Declaration
 * order zips with the SAB array index.
 *
 * - `name`: state slot name
 * - `type`: scalar type (= f32 / i32 / bool; restricted by Q42, all a single 4-byte word)
 * - `sharedOffset`: offset within the publishShared region of WASM memory (= copy source for the value)
 * - `counterOffset`: offset within the publishCounters region of WASM memory (= 8 bytes = sample counter + version counter)
 */
export type PublishSlotDescriptor = {
  readonly name: string;
  readonly type: ScalarType;
  readonly sharedOffset: number;
  readonly counterOffset: number;
};

/**
 * Per-event descriptor for an `event<T>` ringbuffer (= `02-messaging.md` §4 + §5.1).
 *
 * The shared shape used when `createNode` and the worklet template build the
 * SAB allocate + copy path. Lifts the layout's `EventRingSlot`
 * (= compile/layout.ts) to the public surface so main and worklet can read it
 * in common.
 *
 * memory map: `wasmRingBase` ~ + 12 = header `[head, tail, overflowCount]`;
 * + 12 + i × slotSize = start of the i-th slot. Each field's offsetInSlot /
 * byteSize give the read / write position within the slot.
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
 * Per-message descriptor for a `message<T>` ringbuffer (= `02-messaging.md` §5.3).
 *
 * Same pattern as the event descriptor and zips with it, except there is no
 * atSample within the slot. The main side pushes slots into the SAB, which the
 * worklet side mirrors into the WASM memory ring and drains.
 *
 * memory map: `wasmRingBase` ~ + 12 = header `[head, tail, overflowCount]`;
 * + 12 + i × slotSize = start of the i-th slot.
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
 * MIDI ring descriptor exposed on `WorkletNamespace.midiRings` (`11-midi.md` §4).
 * Built from the layout's `midiRings` + `sysexContent` regions. One entry per
 * `midiInput` / `midiOutput` declaration; `createNode` reads them to size the
 * SAB ring + sysex content buffers and to wire `node.midi.<name>`, and the
 * worklet template reads them to drain (in) / emit (out) the WASM ring.
 *
 * `direction` mirrors the message/event split: `"in"` = main produces, worklet
 * drains (= message-ring transport); `"out"` = worklet emits, main drains
 * (= event-ring transport). Each slot is the fixed 8-byte MIDI wire layout
 * (§4.1); sysex (§4.3) travels through the optional `sysex` content region.
 */
export type MidiRingSlotDescriptor = {
  readonly name: string;
  readonly direction: "in" | "out";
  readonly wasmRingBase: number;
  readonly capacity: number;
  /**
   * Present when this port carries sysex (`0xF0`) events. `wasmBase` = byte
   * offset of the content region in WASM linear memory; `perChunk` = bytes per
   * `[length:u32, data]` chunk; `chunks` = chunk count. The 8-byte ring slot
   * carries `[0xF0, chunkIdx, _pad, _pad, atSample]` and `chunkIdx` indexes here.
   */
  readonly sysex?: {
    readonly wasmBase: number;
    readonly perChunk: number;
    readonly chunks: number;
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
 * imported via `@unworklet/unplugin`'s `?worklet` virtual module (or
 * an equivalent live-coding helper that populates the same fields).
 * `createNode` reads them to wire `audioWorklet.addModule(...)` +
 * `new AudioWorkletNode(...)`.
 *
 * `displayName` is the human-readable processor name (the source's export
 * name, e.g. `tapeDelay`). `processorName` is the `registerProcessor` key and
 * carries source/revision hash suffixes for HMR uniqueness, so it is unfit for
 * display — tools read `displayName` instead.
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
  midiRings: readonly MidiRingSlotDescriptor[];
  moduleUrl?: string;
  processorName?: string;
  wasmUrl?: string;
  displayName?: string;
  /**
   * The sampleRate the `?worklet` WASM was compiled at (build time). Rate-dependent
   * coefficients (`tan(pi*fc/sr)`, a delay length `sr*seconds`, a phase increment
   * `freq/sr`) are frozen into the WASM, so running on a context at a different rate
   * detunes the output. `createNode` compares this against `context.sampleRate` and
   * rejects on mismatch. Present only on `?worklet`-imported processors; `undefined`
   * for inline namespaces (no fixed build rate). This is the seam for a future
   * recompile-at-rate path (recompile at the context rate instead of throwing).
   */
  bakedSampleRate?: number;
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
  /**
   * Internal re-capture thunk: re-runs the `defineProcessor` body with the host
   * `ctx.sampleRate` so `compile` emits rate-specific coefficients. The public
   * `graph` is the rate-independent eager capture (declarations / layout / meta).
   */
  readonly __capture?: (sampleRate: number) => ProcessorGraph;
  readonly __compiledProcessor: C;
};

/**
 * Resolve a node-handle config from either the config directly or a
 * `CompiledProcessor<config>` (a `?worklet` import), so `UnworkletNode<P>` can be
 * named with the processor itself —
 * `let node: UnworkletNode<typeof import("./x.processor.ts?worklet")>` — and not
 * only its inner config. A config (no `CompiledProcessor` shape) passes through
 * unchanged, so `createNode`'s internal `UnworkletNode<C>` is unaffected.
 */
type ConfigOf<P> = P extends CompiledProcessor<infer C> ? C : P;

export type Migration = {
  from: string;
  to: string;
  /**
   * Synchronous blob transform. Migrations must be sync: the same chain runs on
   * the worklet's render-quantum boundary (no `await` possible) and in the
   * offline renderer, so an async migrate cannot be honored consistently and is
   * rejected at runtime. (`void` is permissive in TS, so an accidental async
   * function still type-checks but fails loud during `restore`.)
   */
  migrate: (blob: Uint8Array, helpers: MigrationHelpers) => void;
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
  /** The sampleRate this artifact was compiled at (the rate baked into its coefficients). */
  sampleRate: number;
  driver: CompileDriver;
  __compiledProcessor: C;
};

/**
 * Second argument to `compile(processor, options)` (= added in sub-phase 7.3).
 *
 * - `sampleRate`: handed to emit as a build-time-known value (= const-folds the
 *   publish scheduler's threshold `Math.round(sampleRate / rateFps)`). default
 *   = 48000 (= zips with existing test fixtures / host defaults). One wasm = one
 *   sampleRate; a different sampleRate emits a different wasm.
 */
export type CompileOptions = {
  sampleRate?: number;
};

/**
 * Driver-friendly handle exposed on `CompileResult.driver`. Hides the internal
 * layout / graph and gives `renderOffline` / the Phase 6 worklet template a
 * public surface for driving memory I/O + process(). Lazy: WebAssembly.compile
 * + instantiate runs only on the first `instantiate()` call (= so one wasm can
 * be run as multiple instances).
 */
export type CompileDriver = {
  instantiate(): Promise<CompileInstance>;
};

export type CompileInstance = {
  readonly memory: WebAssembly.Memory;
  process(): void;
  readonly declarations: ReadonlyArray<CompileInstanceDeclaration>;
  /** Caller invariant: `blockData.length === SAMPLES_PER_BLOCK`. */
  writeInput(portName: string, channel: number, blockData: Float32Array): void;
  /** Caller invariant: `blockData.length === SAMPLES_PER_BLOCK`. */
  writeParam(paramName: string, blockData: Float32Array): void;
  /** Caller invariant: `dest.length === SAMPLES_PER_BLOCK`. */
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
   * to `self`. The audio thread cannot throw (= `00-foundations.md` §5.1
   * invariant 3), so the runtime posts this once and then continues
   * emitting silence. A compile-time check is impossible (= the custom
   * class lives in user code), so this is the runtime fail-fast signal.
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

/**
 * The full main-side event surface (Q88): `.on` (worklet→main, `event({ to:
 * 'main' })`), `.emit` (main→main, `event({ from: 'main' })`), and the
 * diagnostics handle. `EventSurfaceFor` narrows this down to the directions an
 * individual declared name actually carries; an unknown / permissive witness
 * keeps the full surface here.
 */
export type EventSurface<T> = {
  on(handler: (payload: T & { atSample: number }) => void): () => void;
  // Function-valued property (not a method) so callers can extract it as a bare
  // sender (`const send = node.events.x.emit`) without an unbound-`this` hazard —
  // it is a plain closure with no `this`, matching the former `MessageSender`.
  emit: (payload: T) => void;
  readonly diagnostics: {
    overflowCount(): number;
  };
};

/**
 * Map a witness field marker to its main-side JS payload type. Scalar fields
 * come as a wire-type string (`"f32"` / `"f64"` / `"i32"` / `"i64"` → `number`,
 * `"bool"` → `boolean`); typed-array fields come as `{ array: <el> }` (→
 * `Float32Array` / `Uint8Array` etc.). Anything else falls back to `unknown`.
 */
type WitnessFieldValue<F> = F extends "bool"
  ? boolean
  : F extends "i64"
    ? // 64-bit values cross as bigint, not number: the reader is
      // `DataView.getBigInt64` and the writer `DataView.setBigInt64`. Typing this
      // `number` used to let `payload.tick + 1` compile and then throw.
      // (Irrelevant to `node.state.<name>` — `publish` rejects i64.)
      bigint
    : F extends "f32" | "f64" | "i32"
      ? number
      : F extends { array: "f32" }
        ? Float32Array
        : F extends { array: "u8" }
          ? Uint8Array
          : unknown;

type WitnessPayload<Fields> = { [K in keyof Fields]: WitnessFieldValue<Fields[K]> };

/**
 * The main-side surface for one declared event, narrowed by the per-name
 * witness marker the `?worklet` witness emits:
 * - `{ dir: "out"; fields: {…} }` (`to:'main'`, worklet→main) — receive only
 *   (`.on`), payload derived from `fields`.
 * - `{ dir: "in"; fields: {…} }` (`from:'main'`, main→worklet) — send only
 *   (`.emit`), payload derived from `fields`.
 * - `{ dir: "inout"; fields: {…} }` (a same-name in/out pair, Q87) — both.
 *
 * A legacy string marker (`"out"` / `"in"` / `"inout"`) or an inline processor's
 * permissive map keeps the full surface with an `unknown` payload so existing
 * code is unaffected. Wrong-direction methods `TypeError` at runtime, so
 * narrowing turns that into a compile error (type ⟺ runtime).
 */
export type EventSurfaceFor<D> = D extends { dir: "out"; fields: infer F }
  ? Omit<EventSurface<WitnessPayload<F>>, "emit">
  : D extends { dir: "in"; fields: infer F }
    ? Omit<EventSurface<WitnessPayload<F>>, "on">
    : // A same-name in/out pair is two rings with two payloads: what you send is
      // not what you receive, so each method is typed from its own field set.
      D extends { dir: "inout"; outFields: infer O; inFields: infer I }
      ? {
          on(handler: (payload: WitnessPayload<O> & { atSample: number }) => void): () => void;
          emit: (payload: WitnessPayload<I>) => void;
          readonly diagnostics: { overflowCount(): number };
        }
      : D extends "out"
        ? Omit<EventSurface<unknown>, "emit">
        : D extends "in"
          ? Omit<EventSurface<unknown>, "on">
          : EventSurface<unknown>;

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

/**
 * The main-side surface for one declared MIDI port, narrowed by the per-name
 * witness marker the `?worklet` witness emits:
 * - `{ dir: "in" }` (`from:'main'`, main → worklet) — main sends `.send()` /
 *   `.connectFromWebMIDI()`; `.onEvent()` is not applicable (main is the
 *   producer).
 * - `{ dir: "out" }` (`to:'main'`, worklet → main) — main observes via
 *   `.onEvent()`; `.send()` / `.connectFromWebMIDI()` are not applicable.
 * A legacy `unknown` marker (or the permissive-map fallback) keeps the full
 * surface. Wrong-direction methods `TypeError` at runtime, so narrowing turns
 * that into a compile error (type ⟺ runtime).
 */
export type MidiPortSurfaceFor<D> = D extends { dir: "in" }
  ? Omit<MidiPortSurface, "onEvent">
  : D extends { dir: "out" }
    ? Omit<MidiPortSurface, "send" | "connectFromWebMIDI">
    : MidiPortSurface;

export type UnworkletNode<P> = UnworkletNodeOf<ConfigOf<P>>;

/**
 * The structural node-handle surface, resolved against a processor's config `C`.
 * `UnworkletNode<P>` dispatches here after unwrapping a `CompiledProcessor`, so a
 * `?worklet` import and its inner config both land on the same surface.
 */
type UnworkletNodeOf<C> = {
  readonly node: AudioWorkletNode;
  /**
   * Per-`audioInput` AudioNode destinations. Users write
   * `source.connect(node.inputs.main)` and the framework internally routes
   * to the correct input port index of the underlying `AudioWorkletNode`
   * (= Q6 + canonical Ex 1 / 2). Each handle is an `AudioNode`, so all of
   * the `AudioNode.connect(...)` / `disconnect(...)` overloads work natively.
   */
  readonly inputs: C extends { inputs: infer I }
    ? { readonly [K in keyof I]: AudioNode }
    : Record<string, AudioNode>;
  readonly outputs: C extends { outputs: infer O }
    ? {
        readonly [K in keyof O]: {
          connect(target: AudioNode | AudioParam): void;
          disconnect(): void;
        };
      }
    : Record<string, { connect(target: AudioNode | AudioParam): void; disconnect(): void }>;
  /**
   * Per-param AudioParam, keyed by the declared name. When the compiled processor
   * carries a param-name witness (the `?worklet` per-file type the plugin emits),
   * the keys are the exact declared names — `node.params.<name>` completes and an
   * undeclared name is a type error. An unknown witness keeps the permissive map,
   * so a processor without a per-file type behaves as a plain `Record`.
   */
  readonly params: C extends { params: infer P }
    ? { readonly [K in keyof P]: AudioParam }
    : Record<string, AudioParam>;
  readonly state: C extends { state: infer S }
    ? { readonly [K in keyof S]: StateValueProxy<WitnessFieldValue<S[K]>> }
    : Record<string, StateValueProxy<unknown> | BufferValueProxy<unknown>>;
  readonly events: C extends { events: infer E }
    ? { readonly [K in keyof E]: EventSurfaceFor<E[K]> }
    : Record<string, EventSurface<unknown>>;
  readonly midi: C extends { midi: infer M }
    ? { readonly [K in keyof M]: MidiPortSurfaceFor<M[K]> }
    : Record<string, MidiPortSurface>;
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
