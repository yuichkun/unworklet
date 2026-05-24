/**
 * `@unworklet/offline` — pure-JS offline renderer (`13-offline-render.md`).
 *
 * Single public entry point `renderOffline(processor, config)` runs an
 * `@unworklet/core` processor through host JS's `WebAssembly.instantiate`
 * (= Node / Bun / Deno) and returns the resulting PCM + emitted events +
 * end-of-render snapshot blob. Compile is self-contained inside
 * `renderOffline` (= internally invokes `compile` from `@unworklet/core`,
 * `decisions-log.md` Q82 + Q81).
 */

import type { CompiledProcessor } from "@unworklet/core";

/** Single main → worklet message scheduled for an offline render. */
export type OfflineMessage = {
  name: string;
  payload: unknown;
  /** Delivery quantum (block index, 0-based). Omitted = 0 (= render start). */
  atQuantum?: number;
};

/** Single inbound event injected at a sample-accurate offset. */
export type OfflineEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

/** Single worklet → main event recorded during a render. */
export type OfflineEmittedEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

export type RenderOfflineConfig = {
  sampleRate: number;
  /** Render duration in seconds; rounded up to the next `SAMPLES_PER_BLOCK` boundary. */
  duration: number;
  /** Audio input per declared `audioInput({ name })` port. Key = port name, value = per-channel `Float32Array`. */
  inputs?: Record<string, Float32Array[]>;
  /** Param automation per declared `param.named(...)` slot. Key = param name. */
  params?: Record<string, number[]>;
  /** Main → worklet messages scheduled by quantum index. */
  messages?: OfflineMessage[];
  /** Inbound events scheduled by sample-accurate offset. */
  events?: OfflineEvent[];
  /** Snapshot profile name; omitted = union of every `'persistent'` profile. */
  profile?: string;
};

export type RenderOfflineResult = {
  /** Output PCM per declared `audioOutput({ name })` port. */
  outputs: Record<string, Float32Array[]>;
  /** Events the processor emitted during the render. */
  events: OfflineEmittedEvent[];
  /** Snapshot blob (Q5 format) captured at end-of-render. */
  state: Uint8Array;
};

/**
 * Run `processor` for `config.duration` seconds and collect PCM + events
 * + end-of-render snapshot. Internally invokes `@unworklet/core`'s
 * `compile` to emit WASM, then drives the binary through host JS's
 * `WebAssembly.instantiate` per render quantum.
 */
export function renderOffline<C>(
  _processor: CompiledProcessor<C>,
  _config: RenderOfflineConfig,
): Promise<RenderOfflineResult> {
  throw new Error("not implemented");
}
