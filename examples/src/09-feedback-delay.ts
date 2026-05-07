import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  select,
  flushDenormals,
} from "@unworklet/core";

// Stereo ping-pong feedback delay.

export const feedbackDelay = defineProcessor((ctx) => {
  const MAX_DELAY_SAMPLES = ctx.samples(2000); // 2 s of headroom at this SR
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const delayMs = param({
    default: 350,
    min: 1,
    max: 2000,
    automationRate: "k-rate",
    name: "delayMs",
  });
  const feedback = param({
    default: 0.45,
    min: 0,
    max: 0.95,
    automationRate: "k-rate",
    name: "feedback",
  });
  const wet = param({
    default: 0.4,
    min: 0,
    max: 1,
    automationRate: "k-rate",
    name: "wet",
  });
  const dry = param({
    default: 0.7,
    min: 0,
    max: 1,
    automationRate: "k-rate",
    name: "dry",
  });
  const pingPong = param({
    default: 1,
    min: 0,
    max: 1,
    automationRate: "k-rate",
    name: "pingPong",
  });

  const dlyL = buffer.f32({ size: MAX_DELAY_SAMPLES, name: "dlyL" });
  const dlyR = buffer.f32({ size: MAX_DELAY_SAMPLES, name: "dlyR" });
  const head = state.i32(0, { name: "head" });

  const meterL = state.f32(0, { name: "meterL", publish: { rateFps: 30 } });
  const meterR = state.f32(0, { name: "meterR", publish: { rateFps: 30 } });

  return {
    process: () => {
      const dSamples = delayMs.at(0).mul(ctx.sampleRate / 1000).toI32();
      const fb = feedback.at(0);
      const w = wet.at(0);
      const d = dry.at(0);
      const pp = pingPong.at(0);
      const block = head.load();

      forSample((i) => {
        const wIdx = block.add(i).mod(MAX_DELAY_SAMPLES);
        const rIdx = wIdx.sub(dSamples).add(MAX_DELAY_SAMPLES).mod(MAX_DELAY_SAMPLES);

        const inL = main.left.at(i);
        const inR = main.right.at(i);

        const taL = dlyL.read(rIdx);
        const taR = dlyR.read(rIdx);

        // ping-pong cross-feed when pp >= 0.5
        const cross = pp.gte(0.5);
        // Flush subnormals on the feedback tap before storing — without
        // this, decaying tails can stall the audio thread on x86 CPUs that
        // don't have FTZ enabled by default. (docs/04 §6.)
        const newL = flushDenormals(inL.add(select(cross, taR, taL).mul(fb)));
        const newR = flushDenormals(inR.add(select(cross, taL, taR).mul(fb)));

        dlyL.write(wIdx, newL);
        dlyR.write(wIdx, newR);

        const yL = inL.mul(d).add(taL.mul(w));
        const yR = inR.mul(d).add(taR.mul(w));
        out.left.set(i, yL);
        out.right.set(i, yR);

        meterL.store(meterL.load().max(yL.abs()));
        meterR.store(meterR.load().max(yR.abs()));
      });

      head.store(block.add(128).mod(MAX_DELAY_SAMPLES));
      meterL.store(flushDenormals(meterL.load().mul(0.92)));
      meterR.store(flushDenormals(meterR.load().mul(0.92)));
    },
  };
});
