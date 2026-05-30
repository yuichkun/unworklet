/**
 * Browser e2e (postMessage fallback): content region より大きい typed-array
 * message を postMessage 経由で送っても worklet (audio thread) が content 書き込みで
 * crash しない (= Q85 no-trap、worklet.ts の clamp)。
 *
 * worklet は onmessage で content region に直書きするため、clamp 前は src > region
 * で `Uint8Array.set` が audio thread で RangeError を throw した。送信 → render 完走
 * → 先頭 128 要素が出力に届くことを担保。
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import oversizedPayload from "../fixtures/oversized-payload.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

const buildContext = (quanta: number): OfflineAudioContext =>
  new OfflineAudioContext({ numberOfChannels: 1, length: 128 * quanta, sampleRate: SAMPLE_RATE });

test("環境担保: COOP/COEP 無しで crossOriginIsolated false", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("oversized typed-array message を postMessage で送っても worklet が crash しない", async () => {
  const ctx = buildContext(4);
  const node = await createNode(ctx, oversizedPayload);
  node.outputs["main"]!.connect(ctx.destination);

  const samples = new Float32Array(512);
  for (let k = 0; k < 512; k++) samples[k] = (k + 1) / 1024;
  const sender = node.messages["upload"] as (p: { samples: Float32Array }) => void;
  sender({ samples });

  // worklet が onmessage で content を clamp して書く (= clamp 前は audio thread で
  // RangeError)。render が throw せず完走することを担保。
  const rendered = await ctx.startRendering();
  expect(rendered.length).toBe(128 * 4);
  node.dispose();
});
