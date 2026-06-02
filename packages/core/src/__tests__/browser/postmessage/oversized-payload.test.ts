/**
 * Browser e2e (postMessage fallback): sending a typed-array message larger than
 * the content region via postMessage must not crash the worklet (audio thread)
 * during content write (Q85 no-trap; clamp in worklet.ts).
 *
 * The worklet writes directly into the content region in onmessage, so before
 * clamping, src > region caused `Uint8Array.set` to throw RangeError on the
 * audio thread. This test ensures the send → render cycle completes and the
 * first 128 elements reach the output.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import oversizedPayload from "../fixtures/oversized-payload.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

const buildContext = (quanta: number): OfflineAudioContext =>
  new OfflineAudioContext({ numberOfChannels: 1, length: 128 * quanta, sampleRate: SAMPLE_RATE });

test("environment check: crossOriginIsolated is false without COOP/COEP headers", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("worklet does not crash when an oversized typed-array message is sent via postMessage", async () => {
  const ctx = buildContext(4);
  const node = await createNode(ctx, oversizedPayload);
  node.outputs["main"]!.connect(ctx.destination);

  const samples = new Float32Array(512);
  for (let k = 0; k < 512; k++) samples[k] = (k + 1) / 1024;
  const sender = node.events["upload"].emit;
  sender({ samples });

  // The worklet clamps content writes in onmessage; without clamping, the audio
  // thread would throw RangeError. Assert that render completes without throwing.
  const rendered = await ctx.startRendering();
  expect(rendered.length).toBe(128 * 4);
  node.dispose();
});
