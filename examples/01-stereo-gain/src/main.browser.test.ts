/**
 * Phase 6 完 了 条 件 = 「Ex 1 (= meter な し) が browser で 鳴 る +
 * Vitest browser mode で smoke test 通 る」 (`docs/10-roadmap.md` §Phase 6)。
 *
 * 実 行 path = `vp test src/main.browser.test.ts` を browser mode で 起 動
 * (= `vite.config.ts` の `test.browser` 経 由 で chromium に bundle を ロ ー
 * ド)。 real `AudioContext` / `AudioWorkletNode` / `WebAssembly` が 揃 う
 * = canonical Ex 1 を 実 環 境 で 走 ら せ て 出 音 PCM を 検 証 す る。
 *
 * 検 証 戦 略 = `OfflineAudioContext` 経 由 で deterministic な 短 い render
 * (= 数 quantum) を 実 行 し、 final buffer を bit-near な 期 待 値 で 突 き
 * 合 わ せ る。 silent buffer × gain で は trivially zero に な っ て し ま
 * う の で、 amplitude=1.0 の DC signal を 入 力 し て gain=0.5 で out=0.5
 * を 確 認 (= unworklet が 真 に param × input を WASM で 走 ら せ た 担 保)。
 *
 * playwright + @vitest/browser が dev dep に 入 っ て い な い 環 境 で は
 * `vp test` の デ フ ォ ル ト 実 行 か ら 除 外 さ れ る (= vite.config.ts の
 * `test.exclude` で `*.browser.test.ts` を 外 し て あ る)。 ship 前 に は
 * CI で `vp add -D @vitest/browser playwright` + browser mode 起 動 を 配
 * 線 す る。
 */

import stereoGain from "./processor.ts?worklet";
import { createNode } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

const SAMPLE_RATE = 48_000;
const RENDER_QUANTA = 4; // = 4 × 128 = 512 サンプル ぶ ん render す る
const RENDER_FRAMES = 128 * RENDER_QUANTA;
const GAIN = 0.5;
const INPUT_AMP = 1.0;

test("Ex 1 (= stereoGain) が browser で 起 動 + AudioWorklet 経 由 で gain × input を 出 す", async () => {
  // OfflineAudioContext で 短 い render を deterministic に 回 す。
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: RENDER_FRAMES,
    sampleRate: SAMPLE_RATE,
  });

  // 入 力 = ConstantSourceNode × ChannelMergerNode で 両 channel に 1.0 を
  // 流 す (= stereo DC signal)、 expected output = GAIN × INPUT_AMP = 0.5。
  const constantL = new ConstantSourceNode(ctx, { offset: INPUT_AMP });
  const constantR = new ConstantSourceNode(ctx, { offset: INPUT_AMP });
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  constantL.connect(merger, 0, 0);
  constantR.connect(merger, 0, 1);

  const node = await createNode(ctx, stereoGain, { initial: { gain: GAIN } });
  merger.connect(node.inputs.main!);
  node.outputs.main!.connect(ctx.destination);

  constantL.start();
  constantR.start();

  const rendered = await ctx.startRendering();

  // 最 後 の quantum を チ ェ ッ ク (= 立 ち 上 が り transient が 落 ち 着
  // い た と こ ろ で 見 る = a-rate param の ramp 過 渡 を 含 ま な い)。
  const lastSampleL = rendered.getChannelData(0)[RENDER_FRAMES - 1]!;
  const lastSampleR = rendered.getChannelData(1)[RENDER_FRAMES - 1]!;
  const expected = INPUT_AMP * GAIN;
  // a-rate AudioParam は initial value (= setValueAtTime equivalent) に ramp
  // し て く れ る が、 数 quantum 進 ん だ あ と は 安 定 値 で あ る べ き。
  expect(lastSampleL).toBeCloseTo(expected, 3);
  expect(lastSampleR).toBeCloseTo(expected, 3);

  node.dispose();
});
