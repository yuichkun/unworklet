/**
 * Browser e2e (postMessage fallback): typed-array message payload を SAB 不 可 環 境
 * (= COOP/COEP ナ シ) で main → worklet に 送 れ る か を 検 証。
 *
 * postMessage path で は main 側 sender が `port.postMessage({ kind: 'message',
 * ringIndex, payload })` で Float32Array を structured-clone 送 信 → audio thread が
 * onmessage で 受 領 → 次 process 開 始 で content region + slot に 直 書 き。
 *
 * 出 力 PCM は postMessage delivery timing (= MessageChannel task queue の drain) が
 * sync offline render 中 非 決 定 的 な た め、 SAB 側 と 同 じ く 値 一 致 は SAB test
 * で 担 保 し、 こ こ で は 「配 列 が worklet に 届 い て length が 読 め る」 を publish
 * 経 由 (= counter test と 同 reliable path) で 担 保 す る。
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

test("環 境 担 保: COOP/COEP 無 し で crossOriginIsolated false", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: SAB unavailable で postMessage に fallback", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, uploadPlayback);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

test("typed-array message: Float32Array upload → worklet で length 読 取 可", async () => {
  // 配 列 (128 要 素) を upload → handler が `samples.length` を len state に store
  // → publish 経 由 で main 観 測。 len = 128 = 配 列 が content region 経 由 で 届 い て
  // payloadLen が 正 し く 書 か れ た 証 (= postMessage path の 配 線 担 保)。
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

test("typed-array message: upload ナ シ で len = 初 期 0 維 持 (= regression)", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, uploadPlayback);
  node.outputs["main"]!.connect(ctx.destination);
  await ctx.startRendering();
  await waitRAF(2);
  expect(node.state["len"]!.value as number).toBe(0);
  node.dispose();
});
