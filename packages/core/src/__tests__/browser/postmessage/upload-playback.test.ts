/**
 * Browser e2e (postMessage fallback): verifies that typed-array message payloads
 * can be sent from main → worklet in environments without SAB (i.e. no COOP/COEP).
 *
 * On the postMessage path, the main-side sender calls
 * `port.postMessage({ kind: 'message', ringIndex, payload })` to structured-clone a
 * Float32Array to the audio thread, which receives it via onmessage and writes
 * directly into the content region + slot at the start of the next process() call.
 *
 * Output PCM value equality is not asserted here because postMessage delivery timing
 * (MessageChannel task queue drain) is non-deterministic during a synchronous offline
 * render. Value correctness is covered by the SAB-path tests. This suite asserts only
 * that the array reaches the worklet and its length is readable via the publish path
 * (the same reliable path used by the counter tests).
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import uploadPlayback from "../fixtures/upload-playback.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

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

const buildContext = (durationQuanta: number): OfflineAudioContext =>
  new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * durationQuanta,
    sampleRate: SAMPLE_RATE,
  });

test("environment check: crossOriginIsolated is false without COOP/COEP", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: falls back to postMessage when SAB is unavailable", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

test("typed-array message: Float32Array upload → worklet can read length", async () => {
  // Uploads a 128-element array; the handler stores `samples.length` in the len state,
  // which is observed from main via the publish path. len === 128 confirms the array
  // arrived through the content region with payloadLen written correctly
  // (i.e. the postMessage path is wired end-to-end).
  const ctx = buildContext(32);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);
  const samples = new Float32Array(128).fill(0.25);
  const sender = node.events["upload"].emit;
  sender({ samples });
  await ctx.startRendering();
  await waitRAF(2);
  expect(node.state["len"]!.value as number).toBe(128);
  node.dispose();
});

test("typed-array message: len stays at initial 0 when no upload is sent (regression guard)", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);
  await ctx.startRendering();
  await waitRAF(2);
  expect(node.state["len"]!.value as number).toBe(0);
  node.dispose();
});
