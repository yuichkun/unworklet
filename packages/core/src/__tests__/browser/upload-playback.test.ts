/**
 * Browser e2e (SAB transport): verifies that a typed-array message payload sent
 * from main → worklet is readable on the worklet side via a real `AudioContext` +
 * `AudioWorkletNode` + SAB. Main calls `node.events.upload.emit({ samples })` with
 * a `Float32Array`; the worklet plays it back verbatim to the output → black-box
 * assert that the rendered PCM matches the uploaded array.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import uploadPlayback from "./fixtures/upload-playback.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

const buildContext = (durationQuanta: number): OfflineAudioContext =>
  new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * durationQuanta,
    sampleRate: SAMPLE_RATE,
  });

test("typed-array message: Float32Array uploaded from main is played back by the worklet", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);

  // Ramp from 0.004 to 0.5 (each element = m/256, exactly representable as f32).
  const samples = new Float32Array(128);
  for (let k = 0; k < 128; k++) samples[k] = (k + 1) / 256;

  const sender = node.events["upload"].emit;
  sender({ samples });

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  for (let k = 0; k < 128; k++) {
    expect(data[k]).toBeCloseTo(samples[k]!, 5);
  }
  node.dispose();
});

test("typed-array message: sending a second array switches the output to that array", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);

  // The last send wins in drain order, so the output reflects the second array.
  const first = new Float32Array(128).fill(0.1);
  const second = new Float32Array(128).fill(0.4);
  const sender = node.events["upload"].emit;
  sender({ samples: first });
  sender({ samples: second });

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  expect(data[0]).toBeCloseTo(0.4, 5);
  expect(data[127]).toBeCloseTo(0.4, 5);
  node.dispose();
});

test("typed-array message: output stays zero when no upload is sent (regression)", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);
  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  expect(data[0]).toBe(0);
  expect(data[64]).toBe(0);
  node.dispose();
});
