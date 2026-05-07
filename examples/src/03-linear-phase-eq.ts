import {
  defineProcessor,
  audioInput,
  audioOutput,
  state,
  buffer,
  forSample,
} from "@unworklet/core";
import { splat } from "@unworklet/core/simd";

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
        const idx = startHead.add(i).mod(HISTORY_LEN);
        history.write(idx, main.at(0, i));
      });

      forSample((i) => {
        const outIdx = startHead.add(i).mod(HISTORY_LEN);
        let acc = splat(0);
        for (let k = 0; k < FIR_LEN; k += 4) {
          const histIdx = outIdx.sub(k).sub(3).add(HISTORY_LEN).mod(HISTORY_LEN);
          acc = acc.add(history.loadVec(histIdx).mul(impulse.loadVec(k)));
        }
        const sum = acc.lane(0).add(acc.lane(1)).add(acc.lane(2)).add(acc.lane(3));
        out.set(0, i, sum);
      });

      histHead.store(startHead.add(128).mod(HISTORY_LEN));
    },
  };
});
