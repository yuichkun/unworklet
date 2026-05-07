import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  num,
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
      const fc = t.sub(0.5).mul(3500).add(2000);
      // a = exp(-2π fc / sr); b = 1 - a
      const a = fc.mul(-2 * Math.PI / ctx.sampleRate).exp();
      const b = num(1).sub(a);
      // tanh saturator gain compensation
      const tanhDrv = drv.tanh();
      // tilt: low component = lp; high component = original - lp
      const oneMinusT = num(1).sub(t);

      forSample((i) => {
        const sL = main.left.at(i);
        const sR = main.right.at(i);

        // one-pole LP for tone
        const lpLNew = b.mul(sL).add(a.mul(lpL.load()));
        const lpRNew = b.mul(sR).add(a.mul(lpR.load()));
        lpL.store(lpLNew);
        lpR.store(lpRNew);

        const tiltL = oneMinusT.mul(lpLNew).add(t.mul(sL.sub(lpLNew)));
        const tiltR = oneMinusT.mul(lpRNew).add(t.mul(sR.sub(lpRNew)));

        // tanh saturator
        const yL = tiltL.mul(drv).tanh().div(tanhDrv);
        const yR = tiltR.mul(drv).tanh().div(tanhDrv);

        const g = outGain.at(i);
        const oL = yL.mul(g);
        const oR = yR.mul(g);
        out.left.set(i, oL);
        out.right.set(i, oR);

        peak.store(peak.load().max(oL.abs().max(oR.abs())));
      });

      peak.store(peak.load().mul(0.93));
    },
  };
});
