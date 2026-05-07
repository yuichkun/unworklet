import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  add,
  sub,
  mul,
  div,
  tanh,
  abs,
  max,
  exp,
  type Node,
} from "@unworklet/core";

// Soft-knee waveshaper distortion with one-pole tilt EQ + output gain.
export const distortion = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const drive = param({
    default: 4,
    min: 1,
    max: 30,
    automationRate: "k-rate",
    name: "drive",
  });
  const tone = param({
    default: 0.5,
    min: 0,
    max: 1,
    automationRate: "k-rate",
    name: "tone",
  });
  const outGain = param({
    default: 0.4,
    min: 0,
    max: 2,
    automationRate: "a-rate",
    name: "outGain",
  });

  const lpL = state.f32(0, { name: "lpL" });
  const lpR = state.f32(0, { name: "lpR" });
  const peak = state.f32(0, { name: "peak", publish: { rateFps: 30 } });

  return {
    process: () => {
      const drv = drive.at(0);
      const t = tone.at(0);
      // cutoff ranges roughly 250 Hz (t=0) to 3.75 kHz (t=1)
      const fc = add(2000, mul(sub(t, 0.5), 3500));
      // a = exp(-2π fc / sr); b = 1 - a
      const a = exp(div(mul(-2 * Math.PI, fc), ctx.sampleRate));
      const b = sub(1, a);
      // tanh saturator gain compensation
      const tanhDrv = tanh(drv);

      forSample((i) => {
        const sL = main.left.at(i);
        const sR = main.right.at(i);

        // one-pole LP for tone
        const lpLNew = add(mul(b, sL), mul(a, lpL.load()));
        const lpRNew = add(mul(b, sR), mul(a, lpR.load()));
        lpL.store(lpLNew);
        lpR.store(lpRNew);

        // tilt: low component = lpNew; high component = original - lp
        const tiltL = add(mul(sub(1, t), lpLNew), mul(t, sub(sL, lpLNew)));
        const tiltR = add(mul(sub(1, t), lpRNew), mul(t, sub(sR, lpRNew)));

        // tanh saturator
        const yL = div(tanh(mul(tiltL, drv)), tanhDrv);
        const yR = div(tanh(mul(tiltR, drv)), tanhDrv);

        const g = outGain.at(i);
        const oL = mul(yL, g);
        const oR = mul(yR, g);
        out.left.set(i, oL);
        out.right.set(i, oR);

        peak.store(max(peak.load(), max(abs(oL), abs(oR))));
      });

      peak.store(mul(peak.load(), 0.93));
    },
  };
});
