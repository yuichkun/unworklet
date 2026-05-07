import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  num,
  select,
  flushDenormals,
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
      const aCoef = num(1).sub(num(-1).div(aMs.mul(0.001 * ctx.sampleRate)).exp());
      const rCoef = num(1).sub(num(-1).div(rMs.mul(0.001 * ctx.sampleRate)).exp());
      const log10over20 = 20 / Math.LN10;
      const log10ToLn = Math.LN10 / 20;
      const halfK = k.mul(0.5);
      const negHalfK = halfK.neg();
      const recipRMinus1 = num(1).div(r).sub(1);

      forSample((i) => {
        const inL = main.left.at(i);
        const inR = main.right.at(i);
        const det = inL.abs().max(inR.abs());
        const e = env.load();
        const coef = select(det.gt(e), aCoef, rCoef);
        const newE = flushDenormals(e.add(coef.mul(det.sub(e))));
        env.store(newE);

        // dB envelope
        const eDb = newE.add(1e-12).log().mul(log10over20);
        // Soft knee: see classic compressor formulas
        const xMinusT = eDb.sub(t);
        const inKnee = xMinusT.add(halfK);
        const overshoot = recipRMinus1.mul(inKnee.mul(inKnee)).div(k.mul(2));
        // Choose region
        const aboveK = xMinusT.gt(halfK);
        const belowK = xMinusT.lt(negHalfK);
        const grDbAbove = xMinusT.sub(xMinusT.div(r));
        const grDbKnee = overshoot.neg();
        const grDb = select(belowK, 0, select(aboveK, grDbAbove, grDbKnee));

        // grLin = exp(grDb * (LN10/20))   — note grDb is already negative-ish
        const grLin = grDb.abs().neg().mul(log10ToLn).exp();
        const m = makeupDb.at(i);
        const mk = m.mul(log10ToLn).exp();

        out.left.set(i, inL.mul(grLin).mul(mk));
        out.right.set(i, inR.mul(grLin).mul(mk));

        const cur = gainReductionDb.load();
        const newGr = grDb.abs().neg();
        gainReductionDb.store(cur.min(newGr));
      });

      gainReductionDb.store(flushDenormals(gainReductionDb.load().mul(0.86)));
    },
  };
});
