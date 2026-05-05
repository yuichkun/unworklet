import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  message,
  add,
  sub,
  mul,
  mod,
  max,
  abs,
} from "@unworklet/core";
import { splat, mulVec, addVec } from "@unworklet/core/simd";

const IR_LEN = 4096;

export const convolutionReverb = defineProcessor(
  (ctx) => {
    const main = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 2, name: "main" });

    const wetGain = param({
      default: 0.5,
      min: 0,
      max: 1,
      automationRate: "k-rate",
      name: "wetGain",
    });
    const dryGain = param({
      default: 0.7,
      min: 0,
      max: 1,
      automationRate: "k-rate",
      name: "dryGain",
    });
    const irChoice = param({
      default: 0,
      min: 0,
      max: 3,
      automationRate: "k-rate",
      name: "irChoice",
    });

    const irL = buffer.f32({ size: IR_LEN, name: "irL", snapshot: "persistent" });
    const irR = buffer.f32({ size: IR_LEN, name: "irR", snapshot: "persistent" });

    const histL = buffer.f32({ size: IR_LEN, name: "histL", snapshot: "transient" });
    const histR = buffer.f32({ size: IR_LEN, name: "histR", snapshot: "transient" });
    const histHead = state.i32(0, { name: "histHead", snapshot: "transient" });

    const wetMeter = state.f32(0, {
      name: "wetMeter",
      snapshot: "transient",
      publish: { rateFps: 30 },
    });

    const uploadIR = message<{ irL: Float32Array; irR: Float32Array }>({ name: "uploadIR" });

    return {
      process: () => {
        uploadIR.onReceive(({ irL: il, irR: ir }) => {
          const len = Math.min(il.length, IR_LEN);
          for (let i = 0; i < len; i++) irL.write(i, il[i]!);
          for (let i = 0; i < len; i++) irR.write(i, ir[i]!);
          for (let i = len; i < IR_LEN; i++) {
            irL.write(i, 0);
            irR.write(i, 0);
          }
        });

        const headBlock = histHead.load();

        forSample((i) => {
          const idx = mod(add(headBlock, i), IR_LEN);
          histL.write(idx, main.at(0, i));
          histR.write(idx, main.at(1, i));
        });

        forSample.byN(4, (i) => {
          const outIdx = mod(add(headBlock, i), IR_LEN);
          let accL = splat(0);
          let accR = splat(0);
          for (let k = 0; k < IR_LEN; k += 4) {
            const histIdx = mod(add(sub(sub(outIdx, k), 3), IR_LEN), IR_LEN);
            const hL = histL.loadVec(histIdx);
            const hR = histR.loadVec(histIdx);
            const iL = irL.loadVec(k);
            const iR = irR.loadVec(k);
            accL = addVec(accL, mulVec(hL, iL));
            accR = addVec(accR, mulVec(hR, iR));
          }
          const sumL = add(
            add((accL as any).lane(0), (accL as any).lane(1)),
            add((accL as any).lane(2), (accL as any).lane(3)),
          );
          const sumR = add(
            add((accR as any).lane(0), (accR as any).lane(1)),
            add((accR as any).lane(2), (accR as any).lane(3)),
          );

          const dryL = mul(main.at(0, i), dryGain.at(0));
          const dryR = mul(main.at(1, i), dryGain.at(0));
          const wetL = mul(sumL, wetGain.at(0));
          const wetR = mul(sumR, wetGain.at(0));

          out.set(0, i, add(dryL, wetL));
          out.set(1, i, add(dryR, wetR));

          wetMeter.store(max(wetMeter.load(), max(abs(wetL), abs(wetR))));
        });

        histHead.store(mod(add(headBlock, 128), IR_LEN));
        wetMeter.store(mul(wetMeter.load(), 0.93));
      },
    };
  },
  {
    migrations: [
      {
        from: "a3f2c1d0",
        to: "b8c14fe2",
        migrate: (oldBlob, helpers) => {
          const ir = helpers.parseBuffer(oldBlob, "ir", "f32");
          if (ir) {
            helpers.writeBuffer("irL", "f32", ir);
            helpers.writeBuffer("irR", "f32", ir);
          }
        },
      },
      {
        from: "b8c14fe2",
        to: "d7e3a991",
        migrate: () => {
          // dryGain auto-defaulted by name match
        },
      },
    ],
  },
);
