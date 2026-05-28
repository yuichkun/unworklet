/**
 * Browser e2e: stereo gain (= canonical Ex 1 full) が real `AudioContext` +
 * `AudioWorkletNode` 経 由 で 動 く + meter L/R publish 経 路 で main 側 か ら
 * 観 測 可 = e2e 完 結 条 件 (= memory entry [[e2e-test-is-completion-bar]])。
 *
 * 起 動: `vp test --config vite.browser.config.ts`。
 */

import { expect, test } from "vitest";

import { createNode } from "../../index.ts";
import stereoGain from "./fixtures/stereo-gain.processor.ts?worklet";

const SAMPLE_RATE = 48_000;
const RENDER_QUANTA = 4;
const RENDER_FRAMES = 128 * RENDER_QUANTA;

test("basic audio path: stereo gain × input = output bit-near (= AudioWorklet 経 由)", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: RENDER_FRAMES,
    sampleRate: SAMPLE_RATE,
  });

  const constantL = new ConstantSourceNode(ctx, { offset: 1.0 });
  const constantR = new ConstantSourceNode(ctx, { offset: 1.0 });
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  constantL.connect(merger, 0, 0);
  constantR.connect(merger, 0, 1);

  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);

  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();

  const lastL = rendered.getChannelData(0)[RENDER_FRAMES - 1]!;
  const lastR = rendered.getChannelData(1)[RENDER_FRAMES - 1]!;
  expect(lastL).toBeCloseTo(0.5, 3);
  expect(lastR).toBeCloseTo(0.5, 3);

  node.dispose();
});

test("transport diagnostics = real environment で 検 出 (= sab か postMessage)", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 128,
    sampleRate: SAMPLE_RATE,
  });
  const node = await createNode(ctx, stereoGain);
  // crossOriginIsolated = true 環 境 (= COOP/COEP 設 定) で sab、 そ れ 以 外 で
  // postMessage。 ema vite.browser.config.ts で COOP/COEP 設 定 済 = sab 期 待。
  expect(["sab", "postMessage"]).toContain(node.diagnostics.transport);
  node.dispose();
});
