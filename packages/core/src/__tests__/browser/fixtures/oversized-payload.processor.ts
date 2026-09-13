/**
 * Browser e2e fixture (= Q85 no-trap): verifies that sending a typed-array message
 * larger than its per-message byte budget is truncated without crashing.
 *
 * `payloadCapacity: 64` retains sixteen f32 elements in each ring slot. The
 * processor reads 128 positions, so positions past the payload clamp to element 15.
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
          buf.write(i, samples.at(i));
        });
      });
      forSample((i) => {
        out.ch(0).at(i).write(buf.read(i));
      });
    },
  };
});
