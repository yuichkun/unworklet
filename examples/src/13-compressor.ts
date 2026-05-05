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
  exp,
  log,
  abs,
  max,
  gt,
  select,
  type Node,
} from "@unworklet/core";

// Feed-forward dynamic range compressor with soft knee, attack, release, makeup.
export const compressor = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const threshDb = param({
    default: -18,
    min: -60,
    max: 0,
    automationRate: "k-rate",
    name: "threshold",
  });
  const ratio = param({
    default: 4,
    min: 1,
    max: 20,
    automationRate: "k-rate",
    name: "ratio",
  });
  const attackMs = param({
    default: 5,
    min: 0.1,
    max: 200,
    automationRate: "k-rate",
    name: "attackMs",
  });
  const releaseMs = param({
    default: 80,
    min: 1,
    max: 1000,
    automationRate: "k-rate",
    name: "releaseMs",
  });
  const kneeDb = param({
    default: 6,
    min: 0,
    max: 24,
    automationRate: "k-rate",
    name: "kneeDb",
  });
  const makeupDb = param({
    default: 0,
    min: 0,
    max: 24,
    automationRate: "a-rate",
    name: "makeupDb",
  });

  const env = state.f32(0, { name: "env" });
  const gainReductionDb = state.f32(0, {
    name: "gainReductionDb",
    publish: { rateFps: 30 },
  });

  return {
    process: () => {
      const t = threshDb.at(0) as unknown as number;
      const r = ratio.at(0) as unknown as number;
      const k = kneeDb.at(0) as unknown as number;
      const aMs = attackMs.at(0) as unknown as number;
      const rMs = releaseMs.at(0) as unknown as number;
      const aCoef = 1 - Math.exp(-1 / (aMs * 0.001 * ctx.sampleRate));
      const rCoef = 1 - Math.exp(-1 / (rMs * 0.001 * ctx.sampleRate));

      forSample((i) => {
        const inL = main.at(0, i) as unknown as number;
        const inR = main.at(1, i) as unknown as number;
        const det = Math.max(Math.abs(inL), Math.abs(inR));
        const e = env.load() as unknown as number;
        const coef = det > e ? aCoef : rCoef;
        const newE = e + coef * (det - e);
        env.store(newE);

        // Convert to dB
        const eDb = 20 * Math.log10(newE + 1e-12);
        // Soft knee
        let grDb = 0;
        if (eDb < t - k * 0.5) grDb = 0;
        else if (eDb > t + k * 0.5) grDb = (eDb - t) - (eDb - t) / r;
        else {
          const x = eDb - t + k * 0.5;
          const overshoot = ((1 / r - 1) * x * x) / (2 * k);
          grDb = -overshoot;
        }
        // grDb is the negative gain reduction in dB
        const grLin = Math.pow(10, -Math.abs(grDb) / 20);
        const m = makeupDb.at(i) as unknown as number;
        const mk = Math.pow(10, m / 20);

        out.set(0, i, (inL * grLin * mk) as unknown as Node<"f32">);
        out.set(1, i, (inR * grLin * mk) as unknown as Node<"f32">);

        // Track most-negative GR
        const cur = gainReductionDb.load() as unknown as number;
        gainReductionDb.store((cur < -Math.abs(grDb) ? cur : -Math.abs(grDb)) as unknown as number);
      });

      // Slow decay back toward 0 dB
      gainReductionDb.store(mul(gainReductionDb.load(), 0.86));
    },
  };
});
