import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  event,
  num,
  select,
  type Node,
  type State,
} from "@unworklet/core";

const LOOKAHEAD_SAMPLES = 240;

function envelopeFollow(
  x: Node<"f32">,
  attackCoef: Node<"f32">,
  releaseCoef: Node<"f32">,
  prev: State<"f32">,
): Node<"f32"> {
  const r = x.abs();
  const coef = select(r.gt(prev.load()), attackCoef, releaseCoef);
  const y = coef.mul(r.sub(prev.load())).add(prev.load());
  prev.store(y);
  return y;
}

export const lookaheadLimiter = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const ceiling = param({
    default: -1.0,
    min: -24,
    max: 0,
    automationRate: "k-rate",
    name: "ceiling",
  });
  const releaseMs = param({
    default: 50,
    min: 1,
    max: 500,
    automationRate: "k-rate",
    name: "releaseMs",
  });

  const dlyL = buffer.f32({ size: LOOKAHEAD_SAMPLES, name: "dlyL" });
  const dlyR = buffer.f32({ size: LOOKAHEAD_SAMPLES, name: "dlyR" });
  const dlyHead = state.i32(0, { name: "dlyHead" });

  const env = state.f32(0, { name: "env" });
  const gainReductionDb = state.f32(0, {
    name: "gainReductionDb",
    publish: { rateFps: 30 },
  });

  const overshoot = event<{ level: number; channel: 0 | 1 }>({ name: "overshoot" });

  return {
    process: () => {
      const ceilingLin = ceiling.at(0).mul(Math.LN10 * 0.05).exp();
      const releaseSamples = releaseMs.at(0).mul(ctx.sampleRate / 1000);
      const releaseCoef = num(1).sub(num(-1).div(releaseSamples).exp());
      const attackCoef = num(1.0);

      const headBlock = dlyHead.load();

      forSample((i) => {
        const inL = main.left.at(i);
        const inR = main.right.at(i);
        const peak = inL.abs().max(inR.abs());
        const e = envelopeFollow(peak, attackCoef, releaseCoef, env);

        const gr = select(e.gt(ceilingLin), ceilingLin.div(e), 1);
        const grDb20 = gr.log().mul(20 / Math.LN10);

        const wIdx = headBlock.add(i).mod(LOOKAHEAD_SAMPLES);
        dlyL.write(wIdx, inL);
        dlyR.write(wIdx, inR);

        const rIdx = wIdx.add(1).mod(LOOKAHEAD_SAMPLES);
        const xL = dlyL.read(rIdx);
        const xR = dlyR.read(rIdx);

        out.left.set(i, xL.mul(gr));
        out.right.set(i, xR.mul(gr));

        overshoot.emitIf(inL.abs().gt(ceilingLin), {
          atSample: i,
          channel: 0,
          level: inL.abs() as unknown as number,
        });
        overshoot.emitIf(inR.abs().gt(ceilingLin), {
          atSample: i,
          channel: 1,
          level: inR.abs() as unknown as number,
        });

        gainReductionDb.store(gainReductionDb.load().min(grDb20));
      });

      dlyHead.store(headBlock.add(128).mod(LOOKAHEAD_SAMPLES));
      gainReductionDb.store(gainReductionDb.load().mul(0.85));
    },
  };
});
