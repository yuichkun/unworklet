import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  mul,
  max,
  abs,
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
        const l = mul(main.left.at(i), g);
        const r = mul(main.right.at(i), g);
        out.left.set(i, l);
        out.right.set(i, r);

        meterL.store(max(meterL.load(), abs(l)));
        meterR.store(max(meterR.load(), abs(r)));
      });

      // Per-block decay so the meter does not stick at the most recent peak forever.
      meterL.store(mul(meterL.load(), 0.95));
      meterR.store(mul(meterR.load(), 0.95));
    },
  };
});
