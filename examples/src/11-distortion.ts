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
  type Node,
} from "@unworklet/core";

// Soft-knee waveshaper distortion with tone control (one-pole tilt) and output gain.
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

  // Two one-pole filters per channel for tilting the spectrum
  const lpL = state.f32(0, { name: "lpL" });
  const lpR = state.f32(0, { name: "lpR" });
  const peak = state.f32(0, { name: "peak", publish: { rateFps: 30 } });

  return {
    process: () => {
      const drv = drive.at(0) as unknown as number;
      // tone: 0 = darker (more LP), 1 = brighter (more HP)
      const t = tone.at(0) as unknown as number;
      // Cutoff at 1 kHz feels right
      const fc = 2000 + (t - 0.5) * 3500;
      const a = Math.exp((-2 * Math.PI * fc) / ctx.sampleRate);
      const b = 1 - a;

      forSample((i) => {
        let sL = main.at(0, i) as unknown as number;
        let sR = main.at(1, i) as unknown as number;

        // Pre-filter for tone shaping
        const lpLNew = b * sL + a * (lpL.load() as unknown as number);
        const lpRNew = b * sR + a * (lpR.load() as unknown as number);
        lpL.store(lpLNew);
        lpR.store(lpRNew);
        // Tilt EQ: mix of LP and HP
        sL = (1 - t) * lpLNew + t * (sL - lpLNew);
        sR = (1 - t) * lpRNew + t * (sR - lpRNew);

        // Soft saturator
        const yL = Math.tanh(sL * drv) / Math.tanh(drv);
        const yR = Math.tanh(sR * drv) / Math.tanh(drv);

        const g = outGain.at(i) as unknown as number;
        const oL = yL * g;
        const oR = yR * g;
        out.set(0, i, oL as unknown as Node<"f32">);
        out.set(1, i, oR as unknown as Node<"f32">);

        const aOut = Math.max(Math.abs(oL), Math.abs(oR));
        peak.store((peak.load() as unknown as number) > aOut ? peak.load() : (aOut as unknown as Node<"f32">));
      });

      peak.store(mul(peak.load(), 0.93));
    },
  };
});
