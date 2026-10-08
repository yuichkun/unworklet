import {
  audioInput,
  audioOutput,
  defineProcessor,
  event,
  f32,
  forSample,
  i32,
  state,
} from "../../../index.ts";

export const crossrealmStateful = defineProcessor(
  () => {
    const input = audioInput({ channels: 1, name: "main" });
    const output = audioOutput({ channels: 1, name: "main" });
    const blocks = state.i32(0).named("blocks");
    const last = state.f32(0).named("last");
    const history = state.buffer
      .f32({ size: 128 })
      .expose({ name: "history", snapshot: "persistent" });
    const frame = event<{ block: number; level: number; samples: Float32Array }>({
      to: "main",
      name: "frame",
      capacity: 16,
      payloadCapacity: 32,
    });
    return {
      process: () => {
        blocks.write(blocks.read().add(1));
        forSample((i) => {
          const sample = input.ch(0).at(i);
          history.write(i, sample);
          last.write(sample);
          output.ch(0).at(i).write(sample.mul(0.5));
        });
        frame.emitIf(true, {
          atSample: 127,
          block: f32(blocks.read()),
          level: last.read(),
          samples: history,
          length: i32(8),
        });
      },
    };
  },
  { id: "crossrealm-stateful" },
);
