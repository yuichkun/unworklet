/**
 * Black-box behavior: cross-precision `Node`-type conversions, focused on the
 * `bool` ↔ numeric pairs (`01-dsl.md` §2.2 + §4). `bool(node)` lowers to
 * `x != 0`; `i32(boolNode)` / `f32(boolNode)` lower from the internal i32 0/1.
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts";
import { audioInput, audioOutput, state } from "../../dsl/declarations.ts";
import { bool, f32, i32, select } from "../../index.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

test("bool(f32 node) is true exactly when the value is non-zero", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 2, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const b = bool(input.ch(0).at(i)); // f32 → bool (x != 0)
          out
            .ch(0)
            .at(i)
            .write(select(b, 1, 0));
          out.ch(1).at(i).write(f32(b)); // bool → f32 (0.0 / 1.0)
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = 0;
  x[1] = 0.5;
  x[2] = -0.3;
  x[3] = 0;
  x[4] = 1e-20; // tiny but non-zero → true
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 5))).toEqual([0, 1, 1, 0, 1]);
  expect(Array.from(outputs.main![1]!.subarray(0, 5))).toEqual([0, 1, 1, 0, 1]);
});

test("i32(bool node) and f32(bool node) surface the internal 0/1", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 2, name: "main" });
    const t = state.bool(true);
    const f = state.bool(false);
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(f32(i32(t.read()))); // true → 1
          out.ch(1).at(i).write(f32(f.read())); // false → 0
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(1);
  expect(outputs.main![1]![0]).toBe(0);
});

test("bool(i32 node) round-trips through select", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const counter = state.i32(0);
    return {
      process: () => {
        forSample((i) => {
          // counter is 0 on the first sample, then non-zero → bool flips.
          out
            .ch(0)
            .at(i)
            .write(select(bool(counter.read()), 1, 0));
          counter.write(counter.read().add(1));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  expect(outputs.main![0]![0]).toBe(0); // counter 0 → false → 0
  expect(outputs.main![0]![1]).toBe(1); // counter 1 → true → 1
  expect(outputs.main![0]![2]).toBe(1);
});
