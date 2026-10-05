import { audioOutput, defineProcessor, forSample, f32, state } from "../../../index.ts";

export const snapshotNext = defineProcessor(
  () => {
    const out = audioOutput({ name: "main", channels: 1 });
    const value = state.named("value").i32(7);
    return { process: () => forSample((i) => out.ch(0).at(i).write(f32(value.read()))) };
  },
  { id: "snapshot-compatibility" },
);
