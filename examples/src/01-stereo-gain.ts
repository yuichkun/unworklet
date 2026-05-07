import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
} from "@unworklet/core";

export const stereoGain = defineProcessor(() => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const gain = param({
    default: 1.0,
    min: 0.0,
    max: 4.0,
    automationRate: "a-rate",
    name: "gain",
  });

  const meterL = state.f32(0, { name: "meterL", publish: { rateFps: 30 } });
  const meterR = state.f32(0, { name: "meterR", publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const g = gain.at(i);
        const l = main.left.at(i).mul(g);
        const r = main.right.at(i).mul(g);
        out.left.set(i, l);
        out.right.set(i, r);

        meterL.store(meterL.load().max(l.abs()));
        meterR.store(meterR.load().max(r.abs()));
      });

      // Per-block decay so the meter does not stick at the most recent peak forever.
      meterL.store(meterL.load().mul(0.95));
      meterR.store(meterR.load().mul(0.95));
    },
  };
});
