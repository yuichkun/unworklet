/**
 * Browser e2e fixture (= Q85 no-trap): verifies that sending a typed-array message
 * larger than the content region does not crash — it is silently truncated instead.
 *
 * `payloadCapacity: 64` bytes → content region = 64 × min(capacity 256, 16) = 1024
 * bytes = 256 f32. When the producer (client SAB / worklet postMessage) sends an array
 * larger than this, it must truncate-copy into the region without throwing a
 * `Uint8Array.set` RangeError. The first 128 elements are written to the buffer and
 * played back as output.
 */

import { event, audioOutput, state, defineProcessor, forSample } from "../../../index.ts";

export const oversizedPayload = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const upload = event<{ samples: Float32Array }>({
    from: "main",
    name: "upload",
    payloadCapacity: 64,
  });
  const buf = state.buffer.f32({ size: 128 });
  return {
    process: () => {
      upload.onReceive(({ samples }) => {
        forSample((i) => {
          buf.write(i, samples.at(i)); // first 128 elements after truncation (region holds 256 f32 ⊃ 128)
        });
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});
