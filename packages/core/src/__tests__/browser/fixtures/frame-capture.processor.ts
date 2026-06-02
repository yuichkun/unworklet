/**
 * Browser e2e fixture for typed-array event payloads from worklet to main.
 * On each block, the worklet copies the first FRAME samples of the input into a
 * buffer and sends them to main via `event<{ samples: Float32Array }>`. Main
 * receives a fresh Float32Array of length FRAME through `node.events.frame.on(...)`.
 *
 * Feeding a known signal from an AudioBufferSourceNode makes the received array
 * strictly dependent on the input — a broken transport manifests as corrupted or
 * missing values. The input is also passed through to the output, so audioInput
 * marshalling is exercised as part of the fixture.
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

const FRAME = 8; // number of leading samples to capture and send to main

export const frameCapture = defineProcessor(() => {
  const inp = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const buf = state.buffer.f32({ size: 128 });
  const frame = event<{ samples: Float32Array }>({
    to: "main",
    name: "frame",
    capacity: 16,
    payloadCapacity: FRAME * 4,
  });

  return {
    process: () => {
      forSample((i) => {
        const x = inp.ch(0).at(i);
        buf.write(i, x); // copy input sample into the buffer
        out.ch(0).at(i).write(x); // passthrough
      });
      // Send the first FRAME samples of the block (buf[0..FRAME-1]) to main.
      frame.emitIf(true, { atSample: 0, samples: buf, length: i32(FRAME) });
    },
  };
});
