// A curated TypeScript declaration string fed to Monaco so the in-browser
// editor has IntelliSense for the unworklet DSL surface. Mirrors the
// @unworklet/core public API (declarations.ts + primitives.ts + simd) plus
// the runtime / capture types from types.ts. Keeping this hand-written
// rather than auto-generated makes the playground tooltips clearer than
// the source files themselves (which carry capture/interpret dispatch
// noise users don't need to see).

export const UNWORKLET_DTS = String.raw`
declare module '@unworklet/core' {
  export type ScalarType = 'f32' | 'f64' | 'i32' | 'i64' | 'bool';
  // Chain-method surface attached to every Node value. Methods delegate
  // to the same primitives as the free functions; both styles work.
  interface NumericChain<T extends ScalarType> {
    add(b: Node<T> | number): Node<T>;
    sub(b: Node<T> | number): Node<T>;
    mul(b: Node<T> | number): Node<T>;
    div(b: Node<T> | number): Node<T>;
    mod(b: Node<T> | number): Node<T>;
    neg(): Node<T>;
    min(b: Node<T> | number): Node<T>;
    max(b: Node<T> | number): Node<T>;
    abs(): Node<T>;
    clamp(lo: Node<T> | number, hi: Node<T> | number): Node<T>;
    eq(b: Node<T> | number): Node<'bool'>;
    ne(b: Node<T> | number): Node<'bool'>;
    lt(b: Node<T> | number): Node<'bool'>;
    gt(b: Node<T> | number): Node<'bool'>;
    lte(b: Node<T> | number): Node<'bool'>;
    gte(b: Node<T> | number): Node<'bool'>;
    toF32(): Node<'f32'>;
    toF64(): Node<'f64'>;
    toI32(): Node<'i32'>;
    toI64(): Node<'i64'>;
  }
  interface FloatMath<T extends 'f32' | 'f64'> {
    sin(): Node<T>; cos(): Node<T>; tan(): Node<T>; tanh(): Node<T>;
    exp(): Node<T>; log(): Node<T>; sqrt(): Node<T>;
    floor(): Node<T>; ceil(): Node<T>; frac(): Node<T>;
  }
  interface BoolChain {
    eq(b: Node<'bool'> | boolean): Node<'bool'>;
    ne(b: Node<'bool'> | boolean): Node<'bool'>;
  }
  interface VecChain {
    add(b: Node<'f32x4'>): Node<'f32x4'>;
    sub(b: Node<'f32x4'>): Node<'f32x4'>;
    mul(b: Node<'f32x4'>): Node<'f32x4'>;
    div(b: Node<'f32x4'>): Node<'f32x4'>;
    lane(i: 0 | 1 | 2 | 3): Node<'f32'>;
  }
  type MethodsFor<T extends ScalarType | 'f32x4'> =
    T extends 'bool' ? BoolChain :
    T extends 'f32' | 'f64' ? NumericChain<T> & FloatMath<T> :
    T extends 'i32' | 'i64' ? NumericChain<T> :
    T extends 'f32x4' ? VecChain :
    {};
  export type Node<T extends ScalarType | 'f32x4' = ScalarType> =
    { readonly __unworkletType: T } & MethodsFor<T>;

  // ─── Declarations ─────────────────────────────────────────────────────
  export interface State<T extends ScalarType> {
    /** Read the slot's current value. Cheap (single load). */
    load(): Node<T>;
    /** Write the slot. Cheap (single store). */
    store(v: Node<T> | number | boolean): void;
  }
  export interface Buffer<T extends ScalarType> {
    /** Read by index (mod buffer size). */
    read(i: Node<'i32'> | number): Node<T>;
    /** Write by index. */
    write(i: Node<'i32'> | number, v: Node<T> | number): void;
    /** Linearly-interpolated read by float position. f32 buffers only. */
    readInterpolated(pos: Node<'f32'> | number): Node<'f32'>;
    /** Load 4 lanes as a SIMD f32x4 vec. */
    loadVec(offset: Node<'i32'> | number): Node<'f32x4'>;
    /** Store 4 lanes from a SIMD f32x4 vec. */
    storeVec(offset: Node<'i32'> | number, v: Node<'f32x4'>): void;
  }
  export interface ParamHandle {
    /** Read the param at sample index i (use 0 for k-rate). */
    at(i: Node<'i32'> | number): Node<'f32'>;
  }
  /** Channel-bound view exposed via .left / .right on stereo audioInput. */
  export interface StereoChannelInputView {
    at(i: Node<'i32'> | number): Node<'f32'>;
  }
  /** Channel-bound view exposed via .left / .right on stereo audioOutput. */
  export interface StereoChannelOutputView {
    set(i: Node<'i32'> | number, v: Node<'f32'> | number): void;
  }
  export interface AudioInputHandle {
    /** Read input audio at (channel, sampleIndex). Channels are 0-indexed. */
    at(channel: number, i: Node<'i32'> | number): Node<'f32'>;
    readonly channels: number;
    readonly name: string;
    /** Channel 0 view (only present when channels === 2). */
    readonly left: StereoChannelInputView;
    /** Channel 1 view (only present when channels === 2). */
    readonly right: StereoChannelInputView;
  }
  export interface AudioOutputHandle {
    /** Write output audio at (channel, sampleIndex, value). */
    set(channel: number, i: Node<'i32'> | number, v: Node<'f32'> | number): void;
    /** Channel 0 view (only present when channels === 2). */
    readonly left: StereoChannelOutputView;
    /** Channel 1 view (only present when channels === 2). */
    readonly right: StereoChannelOutputView;
  }

  // ─── Declaration constructors ─────────────────────────────────────────
  export const state: {
    f32(initial: number, options?: { name?: string; snapshot?: 'persistent' | 'transient'; publish?: { rateFps: number } }): State<'f32'>;
    i32(initial: number, options?: { name?: string; snapshot?: 'persistent' | 'transient'; publish?: { rateFps: number } }): State<'i32'>;
    bool(initial: boolean, options?: { name?: string; snapshot?: 'persistent' | 'transient'; publish?: { rateFps: number } }): State<'bool'>;
    f64(initial: number, options?: { name?: string; snapshot?: 'persistent' | 'transient' }): State<'f64'>;
    i64(initial: number, options?: { name?: string; snapshot?: 'persistent' | 'transient' }): State<'i64'>;
  };
  export const buffer: {
    f32(options: { size: number; name: string; snapshot?: 'persistent' | 'transient'; publish?: { rateFps: number } }): Buffer<'f32'>;
    i32(options: { size: number; name: string; snapshot?: 'persistent' | 'transient' }): Buffer<'i32'>;
    f64(options: { size: number; name: string; snapshot?: 'persistent' | 'transient' }): Buffer<'f64'>;
  };
  export function param(options: {
    name: string;
    default: number; min: number; max: number;
    automationRate: 'a-rate' | 'k-rate';
    unit?: string;
  }): ParamHandle;
  export function audioInput(options: { name: string; channels: number }): AudioInputHandle;
  export function audioOutput(options: { name: string; channels: number }): AudioOutputHandle;

  // ─── Events / messages / MIDI ─────────────────────────────────────────
  export function event<T = any>(options: { name: string; capacity?: number }): {
    /** Emit if cond is true. atSample (in payload) sets the sample-accurate timestamp. */
    emitIf(cond: Node<'bool'> | boolean, payload: Partial<T> & { atSample: Node<'i32'> | number }): void;
  };
  export function message<T = any>(options: {
    name: string;
    capacity?: number;
    /** Variable-length typed-array payload fields. Each gets a per-slot
     *  content area that handlers access via .copyTo / .read / .length. */
    payload?: { [field: string]: { type: 'f32' | 'i32' | 'u8'; maxLength: number } };
  }): {
    /** Register a handler that runs at block start whenever this message arrives. */
    onReceive(handler: (payload: any) => void): void;
  };
  export function midiInput(options?: { name?: string; capacity?: number }): {
    /** Register a handler for a specific MIDI event type. */
    onEvent(type: 'noteOn' | 'noteOff' | 'cc' | 'pitchBend' | 'programChange' | 'channelPressure' | 'aftertouch', handler: (e: any) => void): void;
  };
  export function midiOutput(options?: { name?: string; capacity?: number }): {
    emitIf(cond: Node<'bool'> | boolean, ev: any): void;
  };

  // ─── Control flow ─────────────────────────────────────────────────────
  /** Run the body once per sample of the current render quantum. i is i32 [0..renderQuantum). */
  export const forSample: ((cb: (i: Node<'i32'>) => void) => void) & {
    /** Run every Nth sample only — typical for filter coefficient updates. */
    byN(stride: number, cb: (i: Node<'i32'>) => void): void;
  };
  export function everyNSamples(N: number, cb: () => void): void;
  export function defineSubgraph<A extends any[], R>(body: (...args: A) => R): (...args: A) => R;

  // ─── Arithmetic / math primitives ─────────────────────────────────────
  export function add<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T>;
  export function sub<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T>;
  export function mul<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T>;
  export function div<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T>;
  export function mod<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T>;
  export function neg<T extends ScalarType>(a: Node<T> | number): Node<T>;
  export function min<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T>;
  export function max<T extends ScalarType>(a: Node<T> | number, b: Node<T> | number): Node<T>;
  export function abs<T extends ScalarType>(a: Node<T> | number): Node<T>;
  export function clamp<T extends ScalarType>(v: Node<T> | number, lo: Node<T> | number, hi: Node<T> | number): Node<T>;

  // Comparison
  export function eq(a: any, b: any): Node<'bool'>;
  export function ne(a: any, b: any): Node<'bool'>;
  export function lt(a: any, b: any): Node<'bool'>;
  export function gt(a: any, b: any): Node<'bool'>;
  export function lte(a: any, b: any): Node<'bool'>;
  export function gte(a: any, b: any): Node<'bool'>;

  // Math
  export function sin(a: Node<'f32'> | number): Node<'f32'>;
  export function cos(a: Node<'f32'> | number): Node<'f32'>;
  export function tan(a: Node<'f32'> | number): Node<'f32'>;
  export function tanh(a: Node<'f32'> | number): Node<'f32'>;
  export function exp(a: Node<'f32'> | number): Node<'f32'>;
  export function log(a: Node<'f32'> | number): Node<'f32'>;
  export function sqrt(a: Node<'f32'> | number): Node<'f32'>;
  export function floor(a: Node<'f32'> | number): Node<'f32'>;
  export function ceil(a: Node<'f32'> | number): Node<'f32'>;
  export function frac(a: Node<'f32'> | number): Node<'f32'>;

  // Branchless conditional / type conversion / FTZ
  export function select<T extends ScalarType>(cond: Node<'bool'> | boolean, ifTrue: Node<T> | number, ifFalse: Node<T> | number): Node<T>;
  export function f32(a: any): Node<'f32'>;
  export function f64(a: any): Node<'f64'>;
  export function i32(a: any): Node<'i32'>;
  export function i64(a: any): Node<'i64'>;
  /** Chain-entry helper: lift a JS literal into a graph node. */
  export function num(v: number): Node<'f32'>;
  export function num(v: boolean): Node<'bool'>;
  /** Zero out subnormal values (|x| < 1e-30) so feedback paths don't stall the audio thread on x86. */
  export function flushDenormals(a: Node<'f32'> | number): Node<'f32'>;

  // ─── defineProcessor ──────────────────────────────────────────────────
  export interface ProcessorContext {
    readonly sampleRate: number;
    readonly renderQuantum: number;
    /** Convert milliseconds to integer sample count at this processor's sample rate. */
    samples(ms: number): number;
    /** MIDI note number → frequency in Hz (A4 = 440, MIDI 69). */
    hz(midiNote: number): number;
  }
  export function defineProcessor(
    body: (ctx: ProcessorContext) => { process: () => void },
    options?: {
      migrations?: Array<{
        from: string; to: string;
        migrate: (oldBlob: Uint8Array, helpers: any) => void;
      }>;
    },
  ): unknown;
}

declare module '@unworklet/core/simd' {
  import type { Node } from '@unworklet/core';
  /** Pack 4 f32 values into a vector. */
  export function vec4(a: any, b: any, c: any, d: any): Node<'f32x4'>;
  /** Replicate a single f32 to all 4 lanes. */
  export function splat(x: Node<'f32'> | number): Node<'f32x4'>;
  export function addVec(a: Node<'f32x4'>, b: Node<'f32x4'>): Node<'f32x4'>;
  export function subVec(a: Node<'f32x4'>, b: Node<'f32x4'>): Node<'f32x4'>;
  export function mulVec(a: Node<'f32x4'>, b: Node<'f32x4'>): Node<'f32x4'>;
  export function divVec(a: Node<'f32x4'>, b: Node<'f32x4'>): Node<'f32x4'>;
}

declare module '@unworklet/dsp/precise' {
  export { sin, cos, tan, tanh, exp, log, sqrt } from '@unworklet/core';
}
declare module '@unworklet/dsp/table' {
  export { sin, cos, exp, log } from '@unworklet/core';
}
`;
