/**
 * Browser e2e (postMessage fallback): verifies typed-array event payloads from
 * worklet → main in an environment without SAB (no COOP/COEP headers).
 *
 * The worklet extracts an array from WASM content and attaches it to `port.postMessage`;
 * on the main side, onEventMessage slices from the snapshot using the slot's
 * [payloadLen, payloadOffset].
 *
 * Design invariant (mirrors the SAB variant — pass means correctness):
 * - Feed a known ramp signal (i/256) via AudioBufferSourceNode into the worklet.
 * - The worklet sends back the first 8 input samples of each block as an event array.
 * - postMessage delivery under OfflineAudioContext is best-effort (MessageChannel task
 *   queue drain timing), so only received messages are asserted — but MessageChannel
 *   guarantees order, meaning the k-th received message must **bit-exactly** match
 *   input block k. Input dependency + order + bit-exactness: any broken link in the
 *   chain will surface as a failure.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import frameCapture from "../fixtures/frame-capture.processor.ts?worklet";

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

const expectedBlock = (b: number): number[] =>
  Array.from({ length: FRAME }, (_, k) => (b * 128 + k) / 256);

test("env assertion: crossOriginIsolated is false without COOP/COEP", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: falls back to postMessage when SAB is unavailable", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128,
    sampleRate: SAMPLE_RATE,
  });
  const node = await createNode(ctx, frameCapture);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

test("typed-array event: first 8 input samples per block arrive as an array via worklet→main (postMessage)", async () => {
  const BLOCKS = 3;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * BLOCKS,
    sampleRate: SAMPLE_RATE,
  });
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

  // postMessage is best-effort delivery, but MessageChannel guarantees order.
  // The k-th received message must bit-exactly match input block k,
  // ruling out coincidental passes and silent corruption.
  expect(received.length).toBeGreaterThan(0);
  received.forEach((r, k) => {
    expect(Array.from(r.samples)).toEqual(expectedBlock(k));
  });
  node.dispose();
});
