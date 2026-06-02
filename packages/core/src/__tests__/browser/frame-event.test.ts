/**
 * Browser e2e (SAB transport): end-to-end verification of typed-array event payloads
 * sent from worklet → main via a real AudioWorkletNode, real SAB, and real Atomics.
 *
 * Design rationale — any breakage anywhere surfaces as a failure:
 * - Feed a known ramp (i/256, f32-exact, per-sample distinct) from an AudioBufferSourceNode
 *   into the worklet. The worklet sends the first FRAME samples of each block back to main
 *   as an event array.
 * - The received array is strictly determined by the input, so any broken link in the chain
 *   (compile → WASM boot → worklet content → SAB mirror → cross-thread → main rAF drain
 *   → handler) produces wrong or missing values.
 * - Multiple blocks produce multiple distinct arrays, ruling out accidental matches on a
 *   fixed value.
 * - Compared bit-for-bit with toEqual.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import frameCapture from "./fixtures/frame-capture.processor.ts?worklet";

const SAMPLE_RATE = 48_000;
const FRAME = 8;

const waitRAF = (ticks: number): Promise<void> =>
  new Promise<void>((resolve) => {
    let n = 0;
    const wait = (): void => {
      n += 1;
      if (n >= ticks) {
        resolve();
        return;
      }
      requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  });

// Expected array for block b: input[b*128 .. b*128+FRAME-1] = (b*128+k)/256.
const expectedBlock = (b: number): number[] =>
  Array.from({ length: FRAME }, (_, k) => (b * 128 + k) / 256);

test("typed-array event: first 8 samples of each block are delivered as an array from worklet to main", async () => {
  const BLOCKS = 3;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * BLOCKS,
    sampleRate: SAMPLE_RATE,
  });
  // Known input: sequential ramp i/256 (f32-exact, per-sample distinct, distinct across blocks).
  const inputBuf = ctx.createBuffer(1, 128 * BLOCKS, SAMPLE_RATE);
  const inData = inputBuf.getChannelData(0);
  for (let i = 0; i < inData.length; i++) inData[i] = i / 256;
  const src = new AudioBufferSourceNode(ctx, { buffer: inputBuf });

  const node = await createNode(ctx, frameCapture);
  src.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);

  const received: Array<{ atSample: number; samples: Float32Array }> = [];
  node.events["frame"]!.on((p) => {
    received.push(p as { atSample: number; samples: Float32Array });
  });

  src.start();
  await ctx.startRendering();
  await waitRAF(3);

  // 3 blocks → 3 events. The set of received arrays matches the expected 3 blocks (order-independent).
  expect(received.length).toBe(BLOCKS);
  const got = received.map((r) => Array.from(r.samples).join(","));
  const want = [expectedBlock(0), expectedBlock(1), expectedBlock(2)].map((a) => a.join(","));
  expect([...got].sort()).toEqual([...want].sort());
  node.dispose();
});
