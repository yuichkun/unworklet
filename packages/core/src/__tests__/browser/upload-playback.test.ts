/**
 * Browser e2e (SAB transport): typed-array message payload を main → worklet で
 * 送って worklet 側で読めることを real `AudioContext` + `AudioWorkletNode` + SAB
 * 経由で検証。main で `node.messages.upload({ samples })` に `Float32Array` を渡し、
 * worklet が出力にそのまま再生 → 出力 PCM が送った配列と一致するかを黒箱 assert。
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

test("typed-array message: main で Float32Array upload → worklet が出力に再生", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);

  // 0.004..0.5 の ramp (= 全要素 m/256 = f32 で厳密表現可)。
  const samples = new Float32Array(128);
  for (let k = 0; k < 128; k++) samples[k] = (k + 1) / 256;

  const sender = node.messages["upload"] as (p: { samples: Float32Array }) => void;
  sender({ samples });

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  for (let k = 0; k < 128; k++) {
    expect(data[k]).toBeCloseTo(samples[k]!, 5);
  }
  node.dispose();
});

test("typed-array message: 別配列を送ると出力が切り替わる", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);

  // 末尾 send が drain order で勝つ = 出力は 2 個目の配列。
  const first = new Float32Array(128).fill(0.1);
  const second = new Float32Array(128).fill(0.4);
  const sender = node.messages["upload"] as (p: { samples: Float32Array }) => void;
  sender({ samples: first });
  sender({ samples: second });

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  expect(data[0]).toBeCloseTo(0.4, 5);
  expect(data[127]).toBeCloseTo(0.4, 5);
  node.dispose();
});

test("typed-array message: upload ナシで出力 0 維持 (= regression)", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);
  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  expect(data[0]).toBe(0);
  expect(data[64]).toBe(0);
  node.dispose();
});
