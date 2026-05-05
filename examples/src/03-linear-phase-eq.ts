import {
  defineProcessor,
  audioInput,
  audioOutput,
  state,
  buffer,
  forSample,
  add,
  sub,
  mul,
  mod,
} from "@unworklet/core";
import { splat, mulVec, addVec } from "@unworklet/core/simd";

const FIR_LEN = 1024;
const PART_SIZE = 128;
const NUM_PARTS = FIR_LEN / PART_SIZE;
const HISTORY_LEN = NUM_PARTS * PART_SIZE;

export const linearPhaseEQ = defineProcessor(() => {
  const main = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  const impulse = buffer.f32({ size: FIR_LEN, name: "impulse", snapshot: "persistent" });
  const history = buffer.f32({ size: HISTORY_LEN, name: "history" });
  const histHead = state.i32(0, { name: "histHead", snapshot: "transient" });

  return {
    process: () => {
      const startHead = histHead.load();

      forSample((i) => {
        const idx = mod(add(startHead, i), HISTORY_LEN);
        history.write(idx, main.at(0, i));
      });

      forSample((i) => {
        const outIdx = mod(add(startHead, i), HISTORY_LEN);
        let acc = splat(0);
        for (let k = 0; k < FIR_LEN; k += 4) {
          const histIdx = mod(add(sub(sub(outIdx, k), 3), HISTORY_LEN), HISTORY_LEN);
          const hVec = history.loadVec(histIdx);
          const iVec = impulse.loadVec(k);
          acc = addVec(acc, mulVec(hVec, iVec));
        }
        const sum = add(
          add((acc as any).lane(0), (acc as any).lane(1)),
          add((acc as any).lane(2), (acc as any).lane(3)),
        );
        out.set(0, i, sum);
      });

      histHead.store(mod(add(startHead, 128), HISTORY_LEN));
    },
  };
});
