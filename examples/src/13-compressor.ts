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
  min,
  gt,
  lt,
  select,
  flushDenormals,
  type Node,
} from "@unworklet/core";

// Feed-forward dynamic range compressor with soft knee.
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
      const t = threshDb.at(0);
      const r = ratio.at(0);
      const k = kneeDb.at(0);
      const aMs = attackMs.at(0);
      const rMs = releaseMs.at(0);
      // a = 1 - exp(-1 / (ms * 0.001 * sr))
      const aCoef = sub(1, exp(div(-1, mul(mul(aMs, 0.001), ctx.sampleRate))));
      const rCoef = sub(1, exp(div(-1, mul(mul(rMs, 0.001), ctx.sampleRate))));
      const log10over20 = 20 / Math.LN10;
      const log10ToLn = Math.LN10 / 20;

      forSample((i) => {
        const inL = main.left.at(i);
        const inR = main.right.at(i);
        const det = max(abs(inL), abs(inR));
        const e = env.load();
        const coef = select(gt(det, e), aCoef, rCoef);
        const newE = flushDenormals(add(e, mul(coef, sub(det, e))));
        env.store(newE);

        // dB envelope
        const eDb = mul(log10over20, log(add(newE, 1e-12)));
        // Soft knee: see classic compressor formulas
        const xMinusT = sub(eDb, t);
        // grDb = (xMinusT < -k/2) → 0
        //       ((xMinusT > k/2) → xMinusT - xMinusT/r
        //       else: ((1/r - 1) * (xMinusT + k/2)^2) / (2k)
        const inKnee = sub(add(xMinusT, mul(0.5, k)), 0);
        const overshoot = div(mul(sub(div(1, r), 1), mul(inKnee, inKnee)), mul(2, k));
        // Choose region
        const aboveK = gt(xMinusT, mul(0.5, k));
        const belowK = lt(xMinusT, mul(-0.5, k));
        const grDbAbove = sub(xMinusT, div(xMinusT, r));
        const grDbKnee = sub(0, overshoot);
        const grDb = select(belowK, 0, select(aboveK, grDbAbove, grDbKnee));

        // grLin = exp(grDb * (LN10/20))   — note grDb is already negative-ish
        const grLin = exp(mul(sub(0, abs(grDb)), log10ToLn));
        const m = makeupDb.at(i);
        const mk = exp(mul(m, log10ToLn));

        out.left.set(i, mul(mul(inL, grLin), mk));
        out.right.set(i, mul(mul(inR, grLin), mk));

        const cur = gainReductionDb.load();
        const newGr = sub(0, abs(grDb));
        gainReductionDb.store(min(cur, newGr));
      });

      gainReductionDb.store(flushDenormals(mul(gainReductionDb.load(), 0.86)));
    },
  };
});
