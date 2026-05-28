/**
 * Browser e2e: postMessage fallback path で state.publish が subscribe handler
 * を 連 続 fire す る か。
 *
 * 環 境: COOP/COEP ヘ ッ ダ 無 し config (= `vite.browser-postmessage.config.ts`)
 * 経 由 で `crossOriginIsolated === false` 担 保 = SAB unavailable = unworklet
 * runtime が postMessage transport に fallback。
 *
 * 期 待: render 進 行 中 に worklet が main thread に postMessage で publish 値 を
 * 飛 ば す → main 側 が message 経 由 で 値 を受 け 取 る → subscribe handler が
 * 連 続 fire す る。
 *
 * 現 状: failing (= 余 湖 さ ん 環 境 で 「メ ー タ ー が 動 か な い」 path)。
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import stereoGain from "../fixtures/stereo-gain.processor.ts?worklet";

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

test("環 境 担 保: COOP/COEP 無 し で crossOriginIsolated false", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: SAB unavailable で postMessage に fallback", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 128,
    sampleRate: SAMPLE_RATE,
  });
  const node = await createNode(ctx, stereoGain);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

test("state.subscribe: postMessage 経 路 で handler が 連 続 fire", async () => {
  // render 5 quanta = 640 sample (= 13.3ms @ 48k) = 30fps publish (= 1600 sample
  // 周 期) で は 1 度 も threshold 越 え な い 可 能 性 高 い。 長 め に 16 quanta =
  // 2048 sample (= 42.6ms) で threshold 1 回 以 上 越 え る 設 定。
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 128 * 16,
    sampleRate: SAMPLE_RATE,
  });
  const constantL = new ConstantSourceNode(ctx, { offset: 0.8 });
  const constantR = new ConstantSourceNode(ctx, { offset: 0.8 });
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  constantL.connect(merger, 0, 0);
  constantR.connect(merger, 0, 1);

  const node = await createNode(ctx, stereoGain);
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);

  const fired: number[] = [];
  const off = node.state["meterL"]!.subscribe((v) => {
    fired.push(v as number);
  });

  constantL.start();
  constantR.start();

  // OfflineAudioContext で sync render = postMessage は internal queue。
  // startRendering Promise resolve 後 + rAF tick で polling driver 経 由 で
  // subscribe handler に dispatch 期 待。
  await ctx.startRendering();
  await waitRAF(10);

  expect(fired.length).toBeGreaterThan(0);
  expect(fired.some((v) => v > 0)).toBe(true);

  off();
  node.dispose();
});
