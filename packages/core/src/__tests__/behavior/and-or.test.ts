/**
 * Black-box behavior: logical `and(a, b)` / `or(a, b)` primitives added to
 * complete the symmetric bool operator set alongside `not(b)`. `bool` is
 * internally i32 0/1, so bitwise `i32.and` / `i32.or` on 0/1 operands matches
 * logical semantics exactly; both operands are eagerly evaluated (no
 * short-circuit in WASM realtime, all DSP nodes run at audio rate).
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts";
import { and, or, select } from "../../index.ts";
import { audioInput, audioOutput } from "../../dsl/declarations.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { defineProcessor } from "../../processor.ts";

import { render } from "./render.ts";

// Feed L = input.ch(0), R = input.ch(1) both as gate signals (> 0.5 = true).
// For each sample write `1` when the composed cond is true, else `0`.

test("and(a, b) — free-function form outputs 1 only when both true", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const a = input.left.at(i).gt(0.5);
          const b = input.right.at(i).gt(0.5);
          out
            .ch(0)
            .at(i)
            .write(select(and(a, b), 1, 0));
        });
      },
    };
  });
  const l = new Float32Array(SAMPLES_PER_BLOCK);
  const r = new Float32Array(SAMPLES_PER_BLOCK);
  l[0] = 1;
  r[0] = 1; // T & T = T
  l[1] = 1;
  r[1] = 0; // T & F = F
  l[2] = 0;
  r[2] = 1; // F & T = F
  l[3] = 0;
  r[3] = 0; // F & F = F
  const { outputs } = await render(proc, { inputs: { main: [l, r] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 4))).toEqual([1, 0, 0, 0]);
});

test("or(a, b) — free-function form outputs 1 when either true", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const a = input.left.at(i).gt(0.5);
          const b = input.right.at(i).gt(0.5);
          out
            .ch(0)
            .at(i)
            .write(select(or(a, b), 1, 0));
        });
      },
    };
  });
  const l = new Float32Array(SAMPLES_PER_BLOCK);
  const r = new Float32Array(SAMPLES_PER_BLOCK);
  l[0] = 1;
  r[0] = 1; // T | T = T
  l[1] = 1;
  r[1] = 0; // T | F = T
  l[2] = 0;
  r[2] = 1; // F | T = T
  l[3] = 0;
  r[3] = 0; // F | F = F
  const { outputs } = await render(proc, { inputs: { main: [l, r] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 4))).toEqual([1, 1, 1, 0]);
});

test("a.and(b) method form matches and(a, b)", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const a = input.left.at(i).gt(0.5);
          const b = input.right.at(i).gt(0.5);
          out
            .ch(0)
            .at(i)
            .write(select(a.and(b), 1, 0));
        });
      },
    };
  });
  const l = new Float32Array(SAMPLES_PER_BLOCK);
  const r = new Float32Array(SAMPLES_PER_BLOCK);
  l[0] = 1;
  r[0] = 1;
  l[1] = 1;
  r[1] = 0;
  const { outputs } = await render(proc, { inputs: { main: [l, r] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 2))).toEqual([1, 0]);
});

test("a.or(b) method form matches or(a, b)", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const a = input.left.at(i).gt(0.5);
          const b = input.right.at(i).gt(0.5);
          out
            .ch(0)
            .at(i)
            .write(select(a.or(b), 1, 0));
        });
      },
    };
  });
  const l = new Float32Array(SAMPLES_PER_BLOCK);
  const r = new Float32Array(SAMPLES_PER_BLOCK);
  l[0] = 0;
  r[0] = 1;
  l[1] = 0;
  r[1] = 0;
  const { outputs } = await render(proc, { inputs: { main: [l, r] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 2))).toEqual([1, 0]);
});

test("and(a, boolean-literal true) accepts a JS boolean as the RHS", async () => {
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const a = input.ch(0).at(i).gt(0.5);
          out
            .ch(0)
            .at(i)
            .write(select(and(a, true), 1, 0));
        });
      },
    };
  });
  const x = new Float32Array(SAMPLES_PER_BLOCK);
  x[0] = 1;
  x[1] = 0;
  const { outputs } = await render(proc, { inputs: { main: [x] } });
  expect(Array.from(outputs.main![0]!.subarray(0, 2))).toEqual([1, 0]);
});
