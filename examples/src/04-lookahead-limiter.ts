import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  event,
  add,
  sub,
  mul,
  div,
  mod,
  max,
  min,
  abs,
  gt,
  exp,
  select,
  log,
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
  const r = abs(x);
  const coef = select(gt(r, prev.load()), attackCoef, releaseCoef);
  const y = add(mul(coef, sub(r, prev.load())), prev.load());
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
      const ceilingLin = exp(mul(ceiling.at(0), Math.LN10 * 0.05));
      const releaseSamples = mul(releaseMs.at(0), ctx.sampleRate / 1000);
      const releaseCoef = sub(1, exp(div(-1, releaseSamples)));
      const attackCoef = 1.0 as unknown as Node<"f32">;

      const headBlock = dlyHead.load();

      forSample((i) => {
        const peak = max(abs(main.at(0, i)), abs(main.at(1, i)));
        const e = envelopeFollow(peak, attackCoef, releaseCoef, env);

        const gr = select(gt(e, ceilingLin), div(ceilingLin, e), 1);
        const grDb20 = mul(20 / Math.LN10, log(gr));

        const wIdx = mod(add(headBlock, i), LOOKAHEAD_SAMPLES);
        dlyL.write(wIdx, main.at(0, i));
        dlyR.write(wIdx, main.at(1, i));

        const rIdx = mod(add(wIdx, 1), LOOKAHEAD_SAMPLES);
        const xL = dlyL.read(rIdx);
        const xR = dlyR.read(rIdx);

        out.set(0, i, mul(xL, gr));
        out.set(1, i, mul(xR, gr));

        overshoot.emitIf(gt(abs(main.at(0, i)), ceilingLin), {
          atSample: i,
          channel: 0,
          level: abs(main.at(0, i)) as unknown as number,
        });
        overshoot.emitIf(gt(abs(main.at(1, i)), ceilingLin), {
          atSample: i,
          channel: 1,
          level: abs(main.at(1, i)) as unknown as number,
        });

        gainReductionDb.store(min(gainReductionDb.load(), grDb20));
      });

      dlyHead.store(mod(add(headBlock, 128), LOOKAHEAD_SAMPLES));
      gainReductionDb.store(mul(gainReductionDb.load(), 0.85));
    },
  };
});
