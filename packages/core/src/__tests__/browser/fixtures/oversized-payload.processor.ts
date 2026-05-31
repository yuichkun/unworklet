/**
 * Browser e2e fixture (= Q85 no-trap): content region より大きい typed-array
 * message を送っても crash せず truncate される、を検証する。
 *
 * `payloadCapacity: 64` bytes → content region = 64 × min(capacity 256, 16) = 1024
 * bytes = 256 f32。これより大きい配列を送ると、producer 側 (client SAB / worklet
 * postMessage) は region に truncate して copy するべき (= `Uint8Array.set` の
 * RangeError を出さない)。先頭 128 要素を buffer に写して出力に再生。
 */

import { audioOutput, state, defineProcessor, forSample, message } from "../../../index.ts";

export const oversizedPayload = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ samples: Float32Array }>({ name: "upload", payloadCapacity: 64 });
  const buf = state.buffer.f32({ size: 128 });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        forSample((i) => {
          buf.write(i, samples.at(i)); // truncate 後の先頭 128 (= region 256 f32 ⊃ 128)
        });
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});
