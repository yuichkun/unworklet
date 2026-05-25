/**
 * `@unworklet/offline` — pure-JS offline renderer (`13-offline-render.md`).
 *
 * Single public entry point `renderOffline(processor, config)` runs an
 * `@unworklet/core` processor through host JS's `WebAssembly.instantiate`
 * (= Node / Bun / Deno) and returns the resulting PCM + emitted events +
 * end-of-render snapshot blob.
 *
 * Internally calls `compile(processor)` to obtain the WASM binary and the
 * driver-friendly handle (= `result.driver.instantiate()`)、 そ の handle 越 し
 * に memory I/O + process() を render quantum 単 位 で 反 復。
 *
 * Phase 3 = audio I/O + param 反 映 path だ け fill (= events / state は
 * Phase 7 / 11 で fill)。 duration × sampleRate を `SAMPLES_PER_BLOCK` で
 * 切 り 上 げ た sample 数 ま で render (= `13-offline-render.md` §2.1)。
 */

import type { CompiledProcessor } from "@unworklet/core";
import { compile, SAMPLES_PER_BLOCK } from "@unworklet/core";

export { encodeWav } from "./encodeWav.ts";
export type { EncodeWavBitDepth, EncodeWavOptions } from "./encodeWav.ts";

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

export async function renderOffline<C>(
  processor: CompiledProcessor<C>,
  config: RenderOfflineConfig,
): Promise<RenderOfflineResult> {
  const result = await compile(processor);
  const instance = await result.driver.instantiate();

  const totalSamples =
    Math.ceil((config.duration * config.sampleRate) / SAMPLES_PER_BLOCK) * SAMPLES_PER_BLOCK;
  const blocks = totalSamples / SAMPLES_PER_BLOCK;

  const outputs: Record<string, Float32Array[]> = {};
  for (const decl of instance.declarations) {
    if (decl.kind === "audioOutput") {
      outputs[decl.name] = Array.from(
        { length: decl.channels },
        () => new Float32Array(totalSamples),
      );
    }
  }

  const blockBuffer = new Float32Array(SAMPLES_PER_BLOCK);
  const inputScratch = new Float32Array(SAMPLES_PER_BLOCK);
  const paramScratch = new Float32Array(SAMPLES_PER_BLOCK);

  for (let b = 0; b < blocks; b++) {
    const blockStart = b * SAMPLES_PER_BLOCK;

    for (const decl of instance.declarations) {
      if (decl.kind === "audioInput") {
        const channels = config.inputs?.[decl.name] ?? [];
        for (let c = 0; c < decl.channels; c++) {
          const channelData = channels[c];
          if (channelData) {
            for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
              const abs = blockStart + s;
              inputScratch[s] = abs < channelData.length ? channelData[abs]! : 0;
            }
          } else {
            inputScratch.fill(0);
          }
          instance.writeInput(decl.name, c, inputScratch);
        }
      } else if (decl.kind === "param") {
        const data = config.params?.[decl.name];
        if (!data || data.length === 0) {
          paramScratch.fill(decl.default);
        } else if (data.length === 1) {
          paramScratch.fill(data[0]!);
        } else {
          for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
            const abs = blockStart + s;
            paramScratch[s] = abs < data.length ? data[abs]! : data[data.length - 1]!;
          }
        }
        instance.writeParam(decl.name, paramScratch);
      }
    }

    instance.process();

    for (const decl of instance.declarations) {
      if (decl.kind !== "audioOutput") continue;
      for (let c = 0; c < decl.channels; c++) {
        instance.readOutput(decl.name, c, blockBuffer);
        const dest = outputs[decl.name]![c]!;
        for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
          dest[blockStart + s] = blockBuffer[s]!;
        }
      }
    }
  }

  return { outputs, events: [], state: new Uint8Array(0) };
}
