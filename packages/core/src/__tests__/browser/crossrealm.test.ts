import { commands } from "vite-plus/test/browser";
import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import {
  CROSSREALM_SAMPLES,
  crossRealmInputs,
  observeCrossRealm,
  type CrossRealmEvent,
} from "./fixtures/crossrealm-observation.ts";
import stereoWorklet from "./fixtures/stereo-gain.processor.ts?worklet";
import statefulWorklet from "./fixtures/crossrealm-stateful.processor.ts?worklet";
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

for (const sampleRate of [44_100, 48_000]) {
  for (const name of ["saw", "stereo", "stateful"] as const) {
    test(`cross-realm: ${name} PCM/events/snapshot match renderOffline at ${sampleRate} Hz`, async () => {
      const oracle = await commands.renderCrossRealmOracle(name, sampleRate);
      const ctx = new OfflineAudioContext({
        numberOfChannels: name === "stereo" ? 2 : 1,
        length: CROSSREALM_SAMPLES + 128,
        sampleRate,
      });
      const node = await createNode(
        ctx,
        { saw: sawWorklet, stereo: stereoWorklet, stateful: statefulWorklet }[name],
        { initial: name === "stereo" ? { gain: 0.5 } : {} },
      );
      const received: CrossRealmEvent[] = [];
      const unsubscribe =
        name === "stateful"
          ? node.events.frame!.on((raw) => {
              const { atSample, block, level, samples } = raw as {
                atSample: number;
                block: number;
                level: number;
                samples: Float32Array;
              };
              received.push({
                name: "frame",
                atSample,
                payload: { block, level, samples: Array.from(samples) },
              });
            })
          : () => {};
      let source: AudioBufferSourceNode | undefined;
      try {
        expect(node.diagnostics.transport).toBe(
          globalThis.crossOriginIsolated ? "sab" : "postMessage",
        );
        const input = crossRealmInputs(name);
        if (input.length > 0) {
          const buffer = ctx.createBuffer(input.length, CROSSREALM_SAMPLES, sampleRate);
          for (const [channel, samples] of input.entries())
            buffer.copyToChannel(new Float32Array(samples), channel);
          source = new AudioBufferSourceNode(ctx, { buffer });
          source.connect(node.inputs.main!);
          source.start(0);
        }
        node.outputs.main!.connect(ctx.destination);
        // Drain each quantum while suspended: no wall-clock scheduling or
        // postMessage pool exhaustion is part of this bounded differential test.
        const boundaries = Array.from({ length: 4 }, (_, i) =>
          ctx.suspend(((i + 1) * 128) / sampleRate),
        );
        const rendering = ctx.startRendering();
        let state: Uint8Array = new Uint8Array();
        for (const [block, boundary] of boundaries.entries()) {
          await boundary;
          state = await node.snapshot();
          if (name === "stateful") await expect.poll(() => received.length).toBe(block + 1);
          if (block < boundaries.length - 1) await ctx.resume();
        }
        unsubscribe();
        await ctx.resume();
        const rendered = await rendering;
        const pcm = Array.from({ length: rendered.numberOfChannels }, (_, i) =>
          rendered.getChannelData(i).slice(0, CROSSREALM_SAMPLES),
        );
        expect(observeCrossRealm(pcm, received, state)).toEqual(oracle);
      } finally {
        unsubscribe();
        source?.disconnect();
        node.dispose();
      }
    });
  }
}
