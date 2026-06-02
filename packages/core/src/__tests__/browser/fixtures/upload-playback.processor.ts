/**
 * Browser e2e fixture — receives a typed-array message payload from main to worklet.
 * When main calls `upload({ samples })` with a `Float32Array`, the worklet copies each
 * sample into a buffer via onReceive and plays it back through forSample. If the output
 * PCM matches the uploaded array, the black-box test confirms that the array reached the
 * worklet through the SAB content buffer and was read correctly.
 */

import { event, audioOutput, defineProcessor, forSample, state } from "../../../index.ts";

export const uploadPlayback = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
  const buf = state.buffer.f32({ size: 128 });
  const lenState = state
    .i32(0)
    .expose({ name: "len", snapshot: "transient", publish: { rateFps: 30 } });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        lenState.write(samples.length);
        forSample((i) => {
          buf.write(i, samples.at(i)); // i is Node<i32> = runtime indexed read
        });
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});
