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
  flushDenormals,
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

    const uploadIR = message<{ irL: Float32Array; irR: Float32Array }>({
      name: "uploadIR",
      capacity: 2,
      payload: {
        irL: { type: "f32", maxLength: IR_LEN },
        irR: { type: "f32", maxLength: IR_LEN },
      },
    });

    return {
      process: () => {
        uploadIR.onReceive(({ irL: il, irR: ir }) => {
          il.copyTo(irL, 0, il.length());
          ir.copyTo(irR, 0, ir.length());
        });

        const headBlock = histHead.load();

        forSample((i) => {
          const idx = mod(add(headBlock, i), IR_LEN);
          histL.write(idx, main.left.at(i));
          histR.write(idx, main.right.at(i));
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

          const dryL = mul(main.left.at(i), dryGain.at(0));
          const dryR = mul(main.right.at(i), dryGain.at(0));
          // Flush subnormals on convolution output so a quiet tail doesn't
          // produce denormals that stall the audio thread (docs/04 §6).
          const wetL = flushDenormals(mul(sumL, wetGain.at(0)));
          const wetR = flushDenormals(mul(sumR, wetGain.at(0)));

          out.left.set(i, add(dryL, wetL));
          out.right.set(i, add(dryR, wetR));

          wetMeter.store(max(wetMeter.load(), max(abs(wetL), abs(wetR))));
        });

        histHead.store(mod(add(headBlock, 128), IR_LEN));
        // 0.93 is a one-pole release coefficient close enough to 1.0 that
        // the meter would otherwise produce denormals on silence.
        wetMeter.store(flushDenormals(mul(wetMeter.load(), 0.93)));
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
