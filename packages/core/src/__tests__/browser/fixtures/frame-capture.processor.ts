/**
 * Browser e2e fixture = worklet → main の typed-array event payload。
 * worklet が各ブロックの入力先頭 FRAME サンプルを buffer に写し、`event<{ samples:
 * Float32Array }>` で main に送る。main 側は length FRAME の fresh Float32Array を
 * `node.events.frame.on(...)` で受け取る。
 *
 * 入力を AudioBufferSourceNode で既知信号にすると、受信配列が入力に厳密依存する =
 * transport が壊れていれば値が崩れる/届かない。入力 passthrough も同時に出力する
 * (= audioInput marshal も接続点に含める)。
 */

import {
  audioInput,
  audioOutput,
  state,
  defineProcessor,
  event,
  forSample,
  i32,
} from "../../../index.ts";

const FRAME = 8; // main に送り返す先頭サンプル数

export const frameCapture = defineProcessor(() => {
  const inp = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const buf = state.buffer.f32({ size: 128 });
  const frame = event<{ samples: Float32Array }>({
    name: "frame",
    capacity: 16,
    payloadCapacity: FRAME * 4,
  });

  return {
    process: () => {
      forSample((i) => {
        const x = inp.ch(0).at(i);
        buf.write(i, x); // 入力をバッファに写す
        out.ch(0).at(i).write(x); // passthrough
      });
      // ブロック先頭 FRAME サンプル (= buf[0..FRAME-1]) を main に送る。
      frame.emitIf(true, { atSample: 0, samples: buf, length: i32(FRAME) });
    },
  };
});
