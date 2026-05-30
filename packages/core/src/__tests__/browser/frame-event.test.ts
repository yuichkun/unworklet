/**
 * Browser e2e (SAB transport): worklet → main の typed-array event payload を
 * real AudioWorkletNode + 実 SAB + 実 Atomics 経由で end-to-end 検証。
 *
 * 「通れば成功以外ありえない」設計:
 * - 入力を AudioBufferSourceNode で既知 ramp (i/256 = f32 exact, per-sample distinct)
 *   にして worklet に流す。worklet が各ブロックの入力先頭 8 サンプルを event 配列で
 *   main に送り返す。
 * - 受信配列が入力に厳密依存 = 途中のどの接続点 (compile → WASM boot → worklet content
 *   → SAB mirror → cross-thread → main rAF drain → handler) が壊れても値が崩れる/届かない。
 * - 複数ブロックで複数の異なる配列を確認 = 固定値の偶然一致を排除。
 * - ビット一致 (toEqual) で照合。
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import frameCapture from "./fixtures/frame-capture.processor.ts?worklet";

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

// block b の期待配列 = input[b*128 .. b*128+FRAME-1] = (b*128+k)/256。
const expectedBlock = (b: number): number[] =>
  Array.from({ length: FRAME }, (_, k) => (b * 128 + k) / 256);

test("typed-array event: 各ブロックの入力先頭8サンプルが worklet→main で配列として届く", async () => {
  const BLOCKS = 3;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * BLOCKS,
    sampleRate: SAMPLE_RATE,
  });
  // 既知 input = 通し番号 ramp i/256 (= f32 で厳密表現、per-sample distinct、block 間で別値)。
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

  // 3 ブロック → 3 event。受信配列の集合が期待 3 ブロックと一致 (= 順序非依存)。
  expect(received.length).toBe(BLOCKS);
  const got = received.map((r) => Array.from(r.samples).join(","));
  const want = [expectedBlock(0), expectedBlock(1), expectedBlock(2)].map((a) => a.join(","));
  expect([...got].sort()).toEqual([...want].sort());
  node.dispose();
});
