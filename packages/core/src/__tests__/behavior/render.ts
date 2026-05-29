/**
 * Black-box render harness for behavior tests.
 *
 * Drives a processor end-to-end through the public `compile` API + the
 * `driver` handle (= the same path `@unworklet/offline`'s `renderOffline`
 * uses), observing **only WASM input/output** — never the captured AST or
 * any internal representation. Behavior tests assert on output PCM numbers,
 * so a test stays green across any internal refactor that preserves the
 * numeric contract.
 *
 * Integer / i64 / f64 / bool / SIMD results are observed by writing them to
 * an `audioOutput` via an `f32(...)` conversion (state slots are not readable
 * through the driver — only output ports are). Cross-block behavior (state
 * persistence, ring-buffer wrap, everyNSamples counters) is observed by
 * rendering multiple blocks.
 */

import { compile } from "../../compile/index.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import type { CompiledProcessor } from "../../types.ts";

export type RenderOptions = {
  /** Number of render quanta to run (default 1). State carries across blocks. */
  blocks?: number;
  /** Host sample rate baked into the WASM (default 48000). */
  sampleRate?: number;
  /** Per-`audioInput` channel data, each spanning `blocks × SAMPLES_PER_BLOCK`. */
  inputs?: Record<string, readonly Float32Array[]>;
  /** Per-`param` constant value, broadcast to every sample of every block. */
  params?: Record<string, number>;
};

export type RenderResult = {
  /** Per-`audioOutput` channel data, each spanning `blocks × SAMPLES_PER_BLOCK`. */
  outputs: Record<string, Float32Array[]>;
};

/** Render `processor` and return its output PCM (per port, per channel). */
export async function render<C>(
  processor: CompiledProcessor<C>,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const blocks = options.blocks ?? 1;
  const sampleRate = options.sampleRate ?? 48000;
  const total = blocks * SAMPLES_PER_BLOCK;

  const { driver } = await compile(processor, { sampleRate });
  const instance = await driver.instantiate();

  const inPorts = instance.declarations.filter((d) => d.kind === "audioInput");
  const outPorts = instance.declarations.filter((d) => d.kind === "audioOutput");
  const paramDecls = instance.declarations.filter((d) => d.kind === "param");

  const outputs: Record<string, Float32Array[]> = {};
  for (const p of outPorts) {
    outputs[p.name] = Array.from({ length: p.channels }, () => new Float32Array(total));
  }

  const scratch = new Float32Array(SAMPLES_PER_BLOCK);
  const dest = new Float32Array(SAMPLES_PER_BLOCK);

  for (let b = 0; b < blocks; b++) {
    const off = b * SAMPLES_PER_BLOCK;

    for (const p of inPorts) {
      const channels = options.inputs?.[p.name] ?? [];
      for (let c = 0; c < p.channels; c++) {
        const src = channels[c];
        for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
          scratch[s] = src === undefined ? 0 : (src[off + s] ?? 0);
        }
        instance.writeInput(p.name, c, scratch);
      }
    }

    for (const p of paramDecls) {
      scratch.fill(options.params?.[p.name] ?? p.default);
      instance.writeParam(p.name, scratch);
    }

    instance.process();

    for (const p of outPorts) {
      for (let c = 0; c < p.channels; c++) {
        instance.readOutput(p.name, c, dest);
        outputs[p.name]![c]!.set(dest, off);
      }
    }
  }

  return { outputs };
}
