import { audioOutput, defineProcessor, forSample, param, state } from "../../../index.ts";

export const snapshotOld = defineProcessor(
  () => {
    const out = audioOutput({ name: "main", channels: 1 });
    const value = state.named("value").f32(1);
    param.f32({ default: 0.25, min: 0, max: 1, automationRate: "a-rate" }).named("gain");
    return { process: () => forSample((i) => out.ch(0).at(i).write(value.read())) };
  },
  { id: "snapshot-compatibility" },
);
