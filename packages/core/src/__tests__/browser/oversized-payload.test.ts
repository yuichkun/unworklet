/**
 * Browser e2e (SAB transport): sending a typed-array message larger than the
 * per-message byte budget must not throw a RangeError in the client SAB injector — the
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

  // The declared 64-byte budget retains sixteen f32 elements per message.
  const samples = new Float32Array(512);
  for (let k = 0; k < 512; k++) samples[k] = (k + 1) / 1024;

  const sender = node.events["upload"].emit;
  expect(() => sender({ samples })).not.toThrow();

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  // Reads past the retained payload clamp to its final element.
  for (let k = 0; k < 128; k++) expect(data[k]).toBeCloseTo(samples[Math.min(k, 15)]!, 5);
  node.dispose();
});
