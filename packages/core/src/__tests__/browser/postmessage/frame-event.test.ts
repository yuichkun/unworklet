/**
 * Browser e2e (postMessage fallback): worklet → main の typed-array event payload を
 * SAB 不 可 環 境 (= COOP/COEP ナ シ) で 検 証。
 *
 * worklet が WASM content から配列を抽出して `port.postMessage` に同梱 → main の
 * onEventMessage が slot の [payloadLen, payloadOffset] で snapshot から slice。
 *
 * 「通れば成功以外ありえない」設計 (= SAB 版と同軸):
 * - 入力を AudioBufferSourceNode で既知 ramp (i/256) にして worklet に流す。
 * - worklet が各ブロックの入力先頭 8 サンプルを event 配列で送り返す。
 * - postMessage delivery は OfflineAudioContext で best-effort (= MessageChannel
 *   task queue の drain timing) なので「受信した分」だけ検証するが、MessageChannel
 *   は順序保証 = 受信 k 件目が入力 block k と**ビット一致**することを assert。
 *   入力依存 + 順序 + ビット一致 = 途中の接続点が壊れれば崩れる。
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

test("環 境 担 保: COOP/COEP 無 し で crossOriginIsolated false", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: SAB unavailable で postMessage に fallback", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128,
    sampleRate: SAMPLE_RATE,
  });
  const node = await createNode(ctx, frameCapture);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

test("typed-array event: worklet→main で入力先頭8サンプルが配列で届く (postMessage)", async () => {
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

  // postMessage = best-effort delivery だが MessageChannel は順序保証。 受信 k 件目が
  // 入力 block k とビット一致 = 入力依存 + 順序 + 値、で偶然/破損を排除。
  expect(received.length).toBeGreaterThan(0);
  received.forEach((r, k) => {
    expect(Array.from(r.samples)).toEqual(expectedBlock(k));
  });
  node.dispose();
});
