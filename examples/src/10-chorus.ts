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
  type Node,
} from "@unworklet/core";

// Stereo chorus: two LFO-modulated delay lines mixed with the dry signal.
const MAX_DELAY_SAMPLES = 4800; // up to ~100 ms

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
      const inc = mul(rateHz.at(0), (2 * Math.PI) / ctx.sampleRate) as unknown as number;
      const baseSamples = mul(baseMs.at(0), ctx.sampleRate / 1000) as unknown as number;
      const depthSamples = mul(depthMs.at(0), ctx.sampleRate / 1000) as unknown as number;
      const mixV = mix.at(0) as unknown as number;

      forSample((i) => {
        const phaseL = add(lfoPhase.load(), inc);
        const phaseR = add(phaseL, Math.PI / 2);
        lfoPhase.store(phaseL as unknown as number > 2 * Math.PI ? sub(phaseL, 2 * Math.PI) : phaseL);

        const offL = add(baseSamples, mul(depthSamples, mul(0.5, add(1, sin(phaseL)))));
        const offR = add(baseSamples, mul(depthSamples, mul(0.5, add(1, sin(phaseR)))));

        const wIdx = mod(add(blockHead, i), MAX_DELAY_SAMPLES);
        // Read with linear interpolation
        const rL = readLerp(dlyL, sub(wIdx, offL));
        const rR = readLerp(dlyR, sub(wIdx, offR));

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

function readLerp(buf: ReturnType<typeof buffer.f32>, pos: Node<"f32"> | number): Node<"f32"> {
  // Clamp & linear-interpolate over a ring buffer
  const p = pos as unknown as number;
  const size = MAX_DELAY_SAMPLES;
  let f = p - Math.floor(p);
  let i0 = Math.floor(p) % size;
  if (i0 < 0) i0 += size;
  const i1 = (i0 + 1) % size;
  const a = buf.read(i0) as unknown as number;
  const b = buf.read(i1) as unknown as number;
  return (a + (b - a) * f) as unknown as Node<"f32">;
}
