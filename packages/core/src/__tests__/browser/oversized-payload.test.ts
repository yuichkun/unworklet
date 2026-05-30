/**
 * Browser e2e (SAB transport): content region より大きい typed-array message を
 * 送っても client SAB injector が RangeError を throw せず truncate する (= Q85
 * no-trap)。real `AudioContext` + `AudioWorkletNode` + SAB 経由で検証。
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import oversizedPayload from "./fixtures/oversized-payload.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

const buildContext = (): OfflineAudioContext =>
  new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SAMPLE_RATE });

test("oversized typed-array message は truncate されて crash しない (Q85 no-trap)", async () => {
  const ctx = buildContext();
  const node = await createNode(ctx, oversizedPayload);
  node.outputs["main"]!.connect(ctx.destination);

  // content region = 256 f32 より大きい 512 要素を送る → client が truncate するべき、
  // RangeError を throw しない (= clamp 前は Uint8Array.set が throw した)。
  const samples = new Float32Array(512);
  for (let k = 0; k < 512; k++) samples[k] = (k + 1) / 1024;

  const sender = node.messages["upload"] as (p: { samples: Float32Array }) => void;
  expect(() => sender({ samples })).not.toThrow();

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  // 先頭 128 要素は truncate 後も保持される (= region 256 f32 が先頭 128 を含む)。
  for (let k = 0; k < 128; k++) expect(data[k]).toBeCloseTo(samples[k]!, 5);
  node.dispose();
});
