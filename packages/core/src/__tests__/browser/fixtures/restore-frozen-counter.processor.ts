import { audioOutput, defineProcessor, forSample, param, state } from "../../../index.ts";

export const restoreFrozenCounter = defineProcessor(() => {
  const freeze = param
    .f32({ default: 1, min: 0, max: 1, automationRate: "k-rate" })
    .named("freeze");
  const count = state.named("count").f32(0);
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () =>
      forSample((i) => {
        count.write(count.read().add(freeze.at(i).neg().add(1)));
        out.ch(0).at(i).write(count.read());
      }),
  };
});
