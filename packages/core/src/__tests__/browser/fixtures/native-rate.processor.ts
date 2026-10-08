import { audioOutput, defineProcessor, event, f32, forSample, state } from "../../../index.ts";

export default defineProcessor(
  (ctx) => {
    const output = audioOutput({ channels: 1, name: "main" });
    const counter = state.i32(0).named("counter");
    const blocks = state.i32(0).named("blocks");
    const last = state.f32(0).named("last");
    const frame = event<{ block: number; level: number }>({
      to: "main",
      name: "frame",
      capacity: 16,
    });
    return {
      process: () => {
        forSample((i) => {
          counter.write(counter.read().add(1));
          const value = f32(counter.read()).mul(f32(1 / ctx.sampleRate));
          last.write(value);
          output.ch(0).at(i).write(value);
        });
        blocks.write(blocks.read().add(1));
        frame.emitIf(true, { atSample: 127, block: f32(blocks.read()), level: last.read() });
      },
    };
  },
  { id: "native-rate" },
);
