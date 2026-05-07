import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  num,
  select,
} from "@unworklet/core";

// Stereo chorus: two LFO-modulated delay lines mixed with the dry signal.
const MAX_DELAY_SAMPLES = 4800;

export const chorus = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const rateHz = param({
    default: 0.7,
    min: 0.05,
    max: 8,
    automationRate: "k-rate",
    name: "rateHz",
  });
  const depthMs = param({
    default: 4,
    min: 0,
    max: 20,
    automationRate: "k-rate",
    name: "depthMs",
  });
  const baseMs = param({
    default: 12,
    min: 1,
    max: 40,
    automationRate: "k-rate",
    name: "baseMs",
  });
  const mix = param({
    default: 0.5,
    min: 0,
    max: 1,
    automationRate: "k-rate",
    name: "mix",
  });

  const dlyL = buffer.f32({ size: MAX_DELAY_SAMPLES, name: "dlyL" });
  const dlyR = buffer.f32({ size: MAX_DELAY_SAMPLES, name: "dlyR" });
  const head = state.i32(0, { name: "head" });
  const lfoPhase = state.f32(0, { name: "lfoPhase" });

  return {
    process: () => {
      const blockHead = head.load();
      const inc = rateHz.at(0).mul((2 * Math.PI) / ctx.sampleRate);
      const baseSamples = baseMs.at(0).mul(ctx.sampleRate / 1000);
      const depthSamples = depthMs.at(0).mul(ctx.sampleRate / 1000);
      const mixV = mix.at(0);
      const halfMix = mixV.mul(0.5);
      const dryGain = num(1).sub(halfMix);

      forSample((i) => {
        const phaseLNew = lfoPhase.load().add(inc);
        const phaseR = phaseLNew.add(Math.PI / 2);
        // wrap LFO phase to [0, 2π)
        const phaseL = select(
          phaseLNew.gt(2 * Math.PI),
          phaseLNew.sub(2 * Math.PI),
          phaseLNew,
        );
        lfoPhase.store(phaseL);

        const offL = baseSamples.add(depthSamples.mul(num(1).add(phaseL.sin()).mul(0.5)));
        const offR = baseSamples.add(depthSamples.mul(num(1).add(phaseR.sin()).mul(0.5)));

        const wIdx = blockHead.add(i).mod(MAX_DELAY_SAMPLES);
        // Read with linear interpolation via readInterpolated
        const rL = dlyL.readInterpolated(wIdx.sub(offL));
        const rR = dlyR.readInterpolated(wIdx.sub(offR));

        const inL = main.left.at(i);
        const inR = main.right.at(i);
        dlyL.write(wIdx, inL);
        dlyR.write(wIdx, inR);

        out.left.set(i, inL.mul(dryGain).add(rL.mul(halfMix)));
        out.right.set(i, inR.mul(dryGain).add(rR.mul(halfMix)));
      });

      head.store(blockHead.add(128).mod(MAX_DELAY_SAMPLES));
    },
  };
});
