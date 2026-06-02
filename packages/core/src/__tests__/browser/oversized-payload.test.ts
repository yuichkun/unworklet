/**
 * Browser e2e (SAB transport): sending a typed-array message larger than the
 * content region must not throw a RangeError in the client SAB injector — the
 * payload is silently truncated (Q85 no-trap). Verified with a real
 * `AudioContext` + `AudioWorkletNode` + SAB pipeline.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import oversizedPayload from "./fixtures/oversized-payload.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

const buildContext = (): OfflineAudioContext =>
  new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SAMPLE_RATE });

test("oversized typed-array message is truncated without crashing (Q85 no-trap)", async () => {
  const ctx = buildContext();
  const node = await createNode(ctx, oversizedPayload);
  node.outputs["main"]!.connect(ctx.destination);

  // Send 512 elements, which exceeds the content region of 256 f32 — the client
  // must truncate rather than throw (pre-clamp, Uint8Array.set would throw).
  const samples = new Float32Array(512);
  for (let k = 0; k < 512; k++) samples[k] = (k + 1) / 1024;

  const sender = node.events["upload"].emit;
  expect(() => sender({ samples })).not.toThrow();

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  // The first 128 elements are preserved after truncation (the 256-f32 region covers them).
  for (let k = 0; k < 128; k++) expect(data[k]).toBeCloseTo(samples[k]!, 5);
  node.dispose();
});
