import { audioOutput, defineProcessor, forSample, param, state } from "../../../index.ts";

export const restoreAutomation = defineProcessor(() => {
  const gain = param.f32({ default: 0.25, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  const value = state.named("value").f32(2);
  const out = audioOutput({ channels: 1, name: "main" });
  return { process: () => forSample((i) => out.ch(0).at(i).write(gain.at(i).add(value.read()))) };
});
