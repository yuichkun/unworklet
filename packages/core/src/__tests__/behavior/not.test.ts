/**
 * Black-box behavior: the logical `not(b)` primitive (`01-dsl.md` §2.1, RFC-001
 * S3). `bool` is internally i32 0/1, so `not` lowers to a single `i32.eqz`.
 * Observed only through output PCM — never the emitted instruction.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts";
import { audioInput, audioOutput } from "../../dsl/declarations.ts";
import { not, num, select } from "../../index.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("not(b) inverts a computed bool (free-function form)", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const gate = input.ch(0).at(i).gt(0.5); // input > 0.5
          out
            .ch(0)
            .at(i)
            .write(select(not(gate), num(1), num(0))); // 1 when NOT (input > 0.5)
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = 0; // gate F → not T → 1
  x[1] = 1; // gate T → not F → 0
  x[2] = 0.2; // gate F → not T → 1
  x[3] = 0.9; // gate T → not F → 0
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 4))).toEqual([1, 0, 1, 0]);
});

test("b.not() method form matches not(b)", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const gate = input.ch(0).at(i).gt(0.5);
          out
            .ch(0)
            .at(i)
            .write(select(gate.not(), num(1), num(0)));
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = 0;
  x[1] = 1;
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 2))).toEqual([1, 0]);
});

test("not(not(b)) round-trips to b", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const gate = input.ch(0).at(i).gt(0.5);
          out
            .ch(0)
            .at(i)
            .write(select(not(not(gate)), num(1), num(0)));
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = 0; // gate F → not not F = F → 0
  x[1] = 1; // gate T → not not T = T → 1
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 2))).toEqual([0, 1]);
});
