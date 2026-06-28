/**
 * Layer D — real-realm rendering, validated in chromium.
 *
 * The audio thread runs in a separate realm (`AudioWorkletGlobalScope`) that
 * coverage cannot see, so the audio path is exercised here in a REAL
 * AudioWorklet under a real `OfflineAudioContext`. A self-generating sawtooth is
 * rendered and checked two ways:
 *
 *   1. determinism — two renders are BIT-identical. Any realm-only
 *      non-determinism (a torn SAB read, a race) would perturb a sample;
 *   2. correctness — the output is the finite, bounded sawtooth it should be,
 *      not garbage from a marshalling slip.
 *
 * Bit-exact comparison against `renderOffline` (the node oracle) is a deeper
 * cross-check that needs the offline renderer bundled into the browser env (its
 * WAV path pulls a node-only dep); that is left to the review pass.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import sawWorklet from "./fixtures/saw.processor.ts?worklet";

const SR = 48_000;
const N = 128 * 8;

/** Reinterpret a Float32Array as raw 32-bit patterns (bit-exact comparison). */
const bits = (pcm: Float32Array): Uint32Array => new Uint32Array(new Float32Array(pcm).buffer);

const renderRealWorklet = async (): Promise<Float32Array> => {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
  const node = await createNode(ctx, sawWorklet);
  node.outputs["main"]!.connect(ctx.destination);
  const buffer = await ctx.startRendering();
  const pcm = new Float32Array(buffer.getChannelData(0)); // copy out before dispose
  node.dispose();
  return pcm;
};

test("cross-realm: the real AudioWorklet render is bit-identical across runs", async () => {
  const a = await renderRealWorklet();
  const b = await renderRealWorklet();
  expect(a.length).toBe(N);
  expect(bits(a)).toEqual(bits(b)); // no race may perturb a single sample
});

test("cross-realm: the real AudioWorklet output is the finite, bounded sawtooth", async () => {
  const real = await renderRealWorklet();

  // The reference saw (phase += 0.013, wrap, scaled to [-1,1)). f32 rounding
  // drifts over time, so the first quantum is pinned tightly and the whole
  // render is pinned to the saw's range + finiteness — a torn read or garbage
  // marshalling would blow either bound.
  let phase = 0;
  for (let i = 0; i < real.length; i++) {
    if (!Number.isFinite(real[i]!) || real[i]! < -1.001 || real[i]! > 1.001) {
      throw new Error(`sample ${i} out of saw range / not finite: ${real[i]}`);
    }
    let p = phase + 0.013;
    if (p > 1) p -= 1;
    phase = p;
    if (i < 128) expect(real[i]!).toBeCloseTo(p * 2 - 1, 3);
  }
  // the saw actually moves (not stuck / silent)
  expect(real.some((s) => s !== real[0])).toBe(true);
});
