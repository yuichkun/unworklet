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
  mod,
  abs,
  max,
  gte,
  select,
  flushDenormals,
  i32,
  type Node,
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
      const dSamples = i32(mul(delayMs.at(0), ctx.sampleRate / 1000));
      const fb = feedback.at(0);
      const w = wet.at(0);
      const d = dry.at(0);
      const pp = pingPong.at(0);
      const block = head.load();

      forSample((i) => {
        const wIdx = mod(add(block, i), MAX_DELAY_SAMPLES);
        const rIdx = mod(
          add(sub(wIdx, dSamples), MAX_DELAY_SAMPLES),
          MAX_DELAY_SAMPLES,
        );

        const inL = main.left.at(i);
        const inR = main.right.at(i);

        const taL = dlyL.read(rIdx);
        const taR = dlyR.read(rIdx);

        // ping-pong cross-feed when pp >= 0.5
        const cross = gte(pp, 0.5);
        // Flush subnormals on the feedback tap before storing — without
        // this, decaying tails can stall the audio thread on x86 CPUs that
        // don't have FTZ enabled by default. (docs/04 §6.)
        const newL = flushDenormals(add(inL, mul(select(cross, taR, taL), fb)));
        const newR = flushDenormals(add(inR, mul(select(cross, taL, taR), fb)));

        dlyL.write(wIdx, newL);
        dlyR.write(wIdx, newR);

        const yL = add(mul(inL, d), mul(taL, w));
        const yR = add(mul(inR, d), mul(taR, w));
        out.left.set(i, yL);
        out.right.set(i, yR);

        meterL.store(max(meterL.load(), abs(yL)));
        meterR.store(max(meterR.load(), abs(yR)));
      });

      head.store(mod(add(block, 128), MAX_DELAY_SAMPLES));
      meterL.store(flushDenormals(mul(meterL.load(), 0.92)));
      meterR.store(flushDenormals(mul(meterR.load(), 0.92)));
    },
  };
});
