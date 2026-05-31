/**
 * Black-box render harness sanity check.
 *
 * Proves the `compile`+`driver` harness (= `./render.ts`) drives a processor
 * end-to-end and reads back correct output PCM, exercising **only WASM I/O**
 * on the existing f32 path. Doubles as an f32 regression lock for the
 * multi-type lowering work that follows.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms (.mul / .add / …)
import { audioInput, audioOutput, param, state } from "../../dsl/declarations.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("f32 gain reproduces input × gain on every sample (= harness drives WASM I/O correctly)", async () => {
  const gain = defineProcessor(() => {
    const inp = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const g = param.f32({ default: 1, min: 0, max: 4, automationRate: "k-rate" }).named("g");
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(inp.ch(0).at(i).mul(g.at(i)));
        });
      },
    };
  });

  const input = new Float32Array(SAMPLES_PER_BLOCK);
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) input[k] = k / SAMPLES_PER_BLOCK;

  const { outputs } = await render(gain, { inputs: { main: [input] }, params: { g: 0.5 } });

  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) {
    expect(outputs.main![0]![k]).toBeCloseTo((k / SAMPLES_PER_BLOCK) * 0.5, 6);
  }
});

test("multi-block render carries f32 state across quanta (= harness loops process() per block)", async () => {
  // Running accumulator: out[n] = sum of inputs up to n. With a constant 1.0
  // input the output is 1, 2, 3, … continuing across the block boundary —
  // proving state persists and the harness drives one process() per block.
  const accumulator = defineProcessor(() => {
    const inp = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const acc = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          // Store the running sum, then read it back for output. Binding the sum
          // and reusing it would re-evaluate `acc.read()` after the store (the
          // graph re-emits shared subtrees rather than memoizing them).
          acc.write(acc.read().add(inp.ch(0).at(i)));
          out.ch(0).at(i).write(acc.read());
        });
      },
    };
  });

  const blocks = 2;
  const input = new Float32Array(blocks * SAMPLES_PER_BLOCK).fill(1);

  const { outputs } = await render(accumulator, { blocks, inputs: { main: [input] } });

  const ch = outputs.main![0]!;
  for (let k = 0; k < blocks * SAMPLES_PER_BLOCK; k++) {
    expect(ch[k]).toBeCloseTo(k + 1, 4);
  }
});
