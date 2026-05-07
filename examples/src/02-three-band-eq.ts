import {
  defineProcessor,
  defineSubgraph,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  num,
  type Node,
  type State,
} from "@unworklet/core";

// L1 helper: one biquad sample, Direct Form II Transposed.
function biquadDFIIT(
  x: Node<"f32">,
  b0: Node<"f32">,
  b1: Node<"f32">,
  b2: Node<"f32">,
  a1: Node<"f32">,
  a2: Node<"f32">,
  z1: State<"f32">,
  z2: State<"f32">,
): Node<"f32"> {
  const y = b0.mul(x).add(z1.load());
  const z1n = b1.mul(x).add(z2.load()).sub(a1.mul(y));
  const z2n = b2.mul(x).sub(a2.mul(y));
  z1.store(z1n);
  z2.store(z2n);
  return y;
}

// L1 helper: peaking-EQ coefficients (Audio EQ Cookbook).
function peakingCoeffs(
  freq: Node<"f32">,
  q: Node<"f32">,
  gainDb: Node<"f32">,
  sr: number,
): {
  b0: Node<"f32">;
  b1: Node<"f32">;
  b2: Node<"f32">;
  a1: Node<"f32">;
  a2: Node<"f32">;
} {
  const A = gainDb.mul(0.05 * Math.LN10).exp();
  const w0 = freq.mul((2 * Math.PI) / sr);
  const cosw0 = w0.cos();
  const sinw0 = w0.sin();
  const alpha = sinw0.div(q.mul(2));

  const alphaA = alpha.mul(A);
  const alphaOverA = alpha.div(A);
  const b0Raw = num(1).add(alphaA);
  const b1Raw = cosw0.mul(-2);
  const b2Raw = num(1).sub(alphaA);
  const a0Raw = num(1).add(alphaOverA);
  const a1Raw = cosw0.mul(-2);
  const a2Raw = num(1).sub(alphaOverA);

  const inv = num(1).div(a0Raw);
  return {
    b0: b0Raw.mul(inv),
    b1: b1Raw.mul(inv),
    b2: b2Raw.mul(inv),
    a1: a1Raw.mul(inv),
    a2: a2Raw.mul(inv),
  };
}

const peakingBand = defineSubgraph(
  (input: Node<"f32">, freq: Node<"f32">, q: Node<"f32">, gainDb: Node<"f32">, sr: number) => {
    const z1 = state.f32(0);
    const z2 = state.f32(0);
    const c = peakingCoeffs(freq, q, gainDb, sr);
    return biquadDFIIT(input, c.b0, c.b1, c.b2, c.a1, c.a2, z1, z2);
  },
);

export const threeBandEQ = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const lowF = param({
    default: 120,
    min: 20,
    max: 1000,
    automationRate: "k-rate",
    name: "lowFreq",
  });
  const lowQ = param({ default: 0.7, min: 0.1, max: 8, automationRate: "k-rate", name: "lowQ" });
  const lowG = param({ default: 0, min: -24, max: 24, automationRate: "k-rate", name: "lowGain" });

  const midF = param({
    default: 1000,
    min: 200,
    max: 8000,
    automationRate: "k-rate",
    name: "midFreq",
  });
  const midQ = param({ default: 1.0, min: 0.1, max: 8, automationRate: "k-rate", name: "midQ" });
  const midG = param({ default: 0, min: -24, max: 24, automationRate: "k-rate", name: "midGain" });

  const hiF = param({
    default: 6000,
    min: 1000,
    max: 20000,
    automationRate: "k-rate",
    name: "hiFreq",
  });
  const hiQ = param({ default: 0.7, min: 0.1, max: 8, automationRate: "k-rate", name: "hiQ" });
  const hiG = param({ default: 0, min: -24, max: 24, automationRate: "k-rate", name: "hiGain" });

  return {
    process: () => {
      const lowFv = lowF.at(0);
      const lowQv = lowQ.at(0);
      const lowGv = lowG.at(0);
      const midFv = midF.at(0);
      const midQv = midQ.at(0);
      const midGv = midG.at(0);
      const hiFv = hiF.at(0);
      const hiQv = hiQ.at(0);
      const hiGv = hiG.at(0);

      forSample((i) => {
        const xL = main.left.at(i);
        const xR = main.right.at(i);

        const yL1 = peakingBand(xL, lowFv, lowQv, lowGv, ctx.sampleRate);
        const yL2 = peakingBand(yL1, midFv, midQv, midGv, ctx.sampleRate);
        const yL3 = peakingBand(yL2, hiFv, hiQv, hiGv, ctx.sampleRate);

        const yR1 = peakingBand(xR, lowFv, lowQv, lowGv, ctx.sampleRate);
        const yR2 = peakingBand(yR1, midFv, midQv, midGv, ctx.sampleRate);
        const yR3 = peakingBand(yR2, hiFv, hiQv, hiGv, ctx.sampleRate);

        out.left.set(i, yL3);
        out.right.set(i, yR3);
      });
    },
  };
});
