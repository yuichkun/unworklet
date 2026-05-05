import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  add,
  mul,
  mod,
  type Node,
} from "@unworklet/core";

// Stereo ping-pong feedback delay.
const MAX_DELAY_SAMPLES = 96000; // 2 seconds at 48kHz

export const feedbackDelay = defineProcessor((ctx) => {
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
      const dSamples = mul(delayMs.at(0), ctx.sampleRate / 1000) as unknown as number;
      const fb = feedback.at(0) as unknown as number;
      const w = wet.at(0) as unknown as number;
      const d = dry.at(0) as unknown as number;
      const pp = pingPong.at(0) as unknown as number;
      const block = head.load();

      forSample((i) => {
        const wIdx = mod(add(block, i), MAX_DELAY_SAMPLES);
        const rIdx = mod(add(sub_or_zero(wIdx, dSamples), MAX_DELAY_SAMPLES), MAX_DELAY_SAMPLES);

        const inL = main.at(0, i);
        const inR = main.at(1, i);

        const taL = dlyL.read(rIdx);
        const taR = dlyR.read(rIdx);

        // Cross-feed when ping-pong > 0.5
        const newL = add(inL, mul(pp >= 0.5 ? taR : taL, fb));
        const newR = add(inR, mul(pp >= 0.5 ? taL : taR, fb));

        dlyL.write(wIdx, newL);
        dlyR.write(wIdx, newR);

        const yL = add(mul(inL, d), mul(taL, w));
        const yR = add(mul(inR, d), mul(taR, w));
        out.set(0, i, yL);
        out.set(1, i, yR);

        // Track peaks
        const aL = (yL as unknown as number) < 0 ? -(yL as unknown as number) : (yL as unknown as number);
        const aR = (yR as unknown as number) < 0 ? -(yR as unknown as number) : (yR as unknown as number);
        meterL.store((meterL.load() as unknown as number) > aL ? meterL.load() : aL);
        meterR.store((meterR.load() as unknown as number) > aR ? meterR.load() : aR);
      });

      head.store(mod(add(block, 128), MAX_DELAY_SAMPLES));
      meterL.store(mul(meterL.load(), 0.92));
      meterR.store(mul(meterR.load(), 0.92));
    },
  };
});

// Helper that emulates safe negative subtraction for ring-buffer index.
function sub_or_zero(a: Node<"i32"> | number, b: number): Node<"i32"> {
  const r = (a as unknown as number) - b;
  return (r < 0 ? r + MAX_DELAY_SAMPLES : r) as unknown as Node<"i32">;
}
