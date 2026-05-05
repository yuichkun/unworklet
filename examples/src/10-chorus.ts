import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  add,
  sub,
  mul,
  div,
  mod,
  sin,
  gt,
  select,
  type Node,
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
      const inc = mul(rateHz.at(0), (2 * Math.PI) / ctx.sampleRate);
      const baseSamples = mul(baseMs.at(0), ctx.sampleRate / 1000);
      const depthSamples = mul(depthMs.at(0), ctx.sampleRate / 1000);
      const mixV = mix.at(0);

      forSample((i) => {
        const phaseLNew = add(lfoPhase.load(), inc);
        const phaseR = add(phaseLNew, Math.PI / 2);
        // wrap LFO phase to [0, 2π)
        const phaseL = select(
          gt(phaseLNew, 2 * Math.PI),
          sub(phaseLNew, 2 * Math.PI),
          phaseLNew,
        );
        lfoPhase.store(phaseL);

        const offL = add(baseSamples, mul(depthSamples, mul(0.5, add(1, sin(phaseL)))));
        const offR = add(baseSamples, mul(depthSamples, mul(0.5, add(1, sin(phaseR)))));

        const wIdx = mod(add(blockHead, i), MAX_DELAY_SAMPLES);
        // Read with linear interpolation via readInterpolated
        const rIdxL = sub(wIdx, offL);
        const rIdxR = sub(wIdx, offR);
        const rL = dlyL.readInterpolated(rIdxL);
        const rR = dlyR.readInterpolated(rIdxR);

        const inL = main.at(0, i);
        const inR = main.at(1, i);
        dlyL.write(wIdx, inL);
        dlyR.write(wIdx, inR);

        out.set(0, i, add(mul(inL, sub(1, mul(0.5, mixV))), mul(rL, mul(0.5, mixV))));
        out.set(1, i, add(mul(inR, sub(1, mul(0.5, mixV))), mul(rR, mul(0.5, mixV))));
      });

      head.store(mod(add(blockHead, 128), MAX_DELAY_SAMPLES));
    },
  };
});
