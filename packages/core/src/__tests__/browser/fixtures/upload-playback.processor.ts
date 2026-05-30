/**
 * Browser e2e fixture = typed-array message payload を main → worklet で受領。
 * `upload({ samples })` で main から `Float32Array` を送ると、worklet が onReceive
 * で各サンプルを buffer に写し取り、forSample でそのまま出力に再生する。出力 PCM
 * が送った配列と一致すれば、配列が SAB content buffer 経由で worklet に届いて
 * 読めている、という黒箱確認。
 */

import { audioOutput, buffer, defineProcessor, forSample, message, state } from "../../../index.ts";

export const uploadPlayback = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = message<{ samples: Float32Array }>({ name: "upload" });
  const buf = buffer.f32({ size: 128 });
  const lenState = state
    .i32(0)
    .expose({ name: "len", snapshot: "transient", publish: { rateFps: 30 } });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        lenState.store(samples.length);
        forSample((i) => {
          buf.write(i, samples.at(i)); // i は Node<i32> = runtime indexed read
        });
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});
