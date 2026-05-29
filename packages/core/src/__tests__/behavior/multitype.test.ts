/**
 * Black-box behavior: polymorphic (multi-type) scalar lowering.
 *
 * Each test builds a real processor through the public DSL surface, renders it
 * via the `compile`+`driver` harness, and asserts on **output PCM only** —
 * the AST is never inspected. Integer / bool results are observed by writing
 * them to the output through an `f32(...)` conversion.
 *
 * Stage 1a (i32 + convert): all tests are red until i32 arithmetic / comparison
 * lowering + the `f32` / `i32` constructors (+ the `convert` AST node) land.
 * The harness itself is proven separately in `./harness.test.ts` on the f32 path.
 */

import { expect, test } from "vite-plus/test";

import { audioOutput } from "../../dsl/declarations.ts";
import { f32, f64, i32 } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { select } from "../../dsl/primitives.ts";
import { defineProcessor } from "../../processor.ts";
import type { Node } from "../../types.ts";

import { render } from "./render.ts";

/**
 * A mono generator that writes `build(i)` (an `f32` node) to every sample of
 * channel 0. Renders one block and returns the channel-0 output.
 */
async function gen(build: (i: Node<"i32">) => Node<"f32">): Promise<Float32Array> {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(build(i));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  return outputs.main![0]!;
}

const allEqual = (out: Float32Array, value: number): void => {
  expect([...out]).toEqual(Array<number>(SAMPLES_PER_BLOCK).fill(value));
};

/** Assert the first output sample ≈ value (for non-exact / approximated results). */
const approx = (out: Float32Array, value: number, digits = 5): void => {
  expect(out[0]).toBeCloseTo(value, digits);
};

test("convert: f32(i) turns the i32 loop counter into an f32 ramp 0..127", async () => {
  const out = await gen((i) => f32(i));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe(k);
});

test("i32 literal: f32(i32(5)) is the constant 5", async () => {
  allEqual(await gen(() => f32(i32(5))), 5);
});

test("i32 add: f32(i.add(i32(10))) = k + 10 (integer arithmetic, not f32)", async () => {
  const out = await gen((i) => f32(i.add(i32(10))));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe(k + 10);
});

test("i32 sub: 10 - 3 = 7", async () => {
  allEqual(await gen(() => f32(i32(10).sub(i32(3)))), 7);
});

test("i32 mul: 6 * 7 = 42", async () => {
  allEqual(await gen(() => f32(i32(6).mul(i32(7)))), 42);
});

test("i32 div: 7 / 2 = 3 (truncating signed integer division)", async () => {
  allEqual(await gen(() => f32(i32(7).div(i32(2)))), 3);
});

test("i32 div: -7 / 2 = -3 (truncation toward zero)", async () => {
  allEqual(await gen(() => f32(i32(-7).div(i32(2)))), -3);
});

test("i32 mod: 7 % 3 = 1 (signed remainder)", async () => {
  allEqual(await gen(() => f32(i32(7).mod(i32(3)))), 1);
});

test("i32 mod: -7 % 3 = -1 (sign follows the dividend, WASM rem_s)", async () => {
  allEqual(await gen(() => f32(i32(-7).mod(i32(3)))), -1);
});

test("i32 neg: -(5) = -5", async () => {
  allEqual(await gen(() => f32(i32(5).neg())), -5);
});

test("i32 ring-buffer index pattern: (i + 10) % 8", async () => {
  const out = await gen((i) => f32(i.add(i32(10)).mod(i32(8))));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe((k + 10) % 8);
});

test("i32 eq drives select: i.eq(i32(3)) ? 1 : 0", async () => {
  const out = await gen((i) => select(i.eq(i32(3)), f32(1), f32(0)));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe(k === 3 ? 1 : 0);
});

test("i32 lt drives select: i.lt(i32(64)) ? 1 : 0 (first half / second half)", async () => {
  const out = await gen((i) => select(i.lt(i32(64)), f32(1), f32(0)));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe(k < 64 ? 1 : 0);
});

test("i32 gt drives select: i.gt(i32(64)) ? 1 : 0", async () => {
  const out = await gen((i) => select(i.gt(i32(64)), f32(1), f32(0)));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe(k > 64 ? 1 : 0);
});

test("i32 lte drives select: i.lte(i32(64)) ? 1 : 0", async () => {
  const out = await gen((i) => select(i.lte(i32(64)), f32(1), f32(0)));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe(k <= 64 ? 1 : 0);
});

test("i32 gte drives select: i.gte(i32(64)) ? 1 : 0", async () => {
  const out = await gen((i) => select(i.gte(i32(64)), f32(1), f32(0)));
  for (let k = 0; k < SAMPLES_PER_BLOCK; k++) expect(out[k]).toBe(k >= 64 ? 1 : 0);
});

// ─────────────────────────────────────────────────────────────────────────
// f64 path (Stage 1b-A) — algebraic + math-basic, observed via f32(...) at the
// output. (Transcendentals — sin/cos/tan/tanh/exp/log — land in Stage 1b-B.)
// ─────────────────────────────────────────────────────────────────────────

test("f64 add: 2.5 + 1.5 = 4", async () => {
  allEqual(await gen(() => f32(f64(2.5).add(f64(1.5)))), 4);
});

test("f64 sub: 10.5 - 0.5 = 10", async () => {
  allEqual(await gen(() => f32(f64(10.5).sub(f64(0.5)))), 10);
});

test("f64 mul: 1.5 * 4 = 6", async () => {
  allEqual(await gen(() => f32(f64(1.5).mul(f64(4)))), 6);
});

test("f64 div: 7 / 2 = 3.5 (true division, not truncating)", async () => {
  allEqual(await gen(() => f32(f64(7).div(f64(2)))), 3.5);
});

test("f64 mod: 7.5 % 2 = 1.5 (JS % parity)", async () => {
  allEqual(await gen(() => f32(f64(7.5).mod(f64(2)))), 1.5);
});

test("f64 mod: -7.5 % 2 = -1.5 (sign follows the dividend)", async () => {
  allEqual(await gen(() => f32(f64(-7.5).mod(f64(2)))), -1.5);
});

test("f64 neg: -(3) = -3", async () => {
  allEqual(await gen(() => f32(f64(3).neg())), -3);
});

test("convert f32 → f64 → f32 round-trips: f64(f32(0.5)) = 0.5", async () => {
  allEqual(await gen(() => f32(f64(f32(0.5)))), 0.5);
});

test("convert i32 → f64: f64(i32(5)) = 5", async () => {
  allEqual(await gen(() => f32(f64(i32(5)))), 5);
});

test("convert f64 → i32: i32(f64(3.7)) = 3 (truncate toward zero)", async () => {
  allEqual(await gen(() => f32(i32(f64(3.7)))), 3);
});

test("f64 sqrt: sqrt(2) ≈ 1.41421", async () => {
  approx(await gen(() => f32(f64(2).sqrt())), Math.SQRT2);
});

test("f64 abs: abs(-3.25) = 3.25", async () => {
  allEqual(await gen(() => f32(f64(-3.25).abs())), 3.25);
});

test("f64 floor: floor(2.7) = 2", async () => {
  allEqual(await gen(() => f32(f64(2.7).floor())), 2);
});

test("f64 ceil: ceil(2.1) = 3", async () => {
  allEqual(await gen(() => f32(f64(2.1).ceil())), 3);
});

test("f64 frac: frac(2.75) = 0.75", async () => {
  approx(await gen(() => f32(f64(2.75).frac())), 0.75);
});

test("f64 min: min(2, 5) = 2", async () => {
  allEqual(await gen(() => f32(f64(2).min(f64(5)))), 2);
});

test("f64 max: max(2, 5) = 5", async () => {
  allEqual(await gen(() => f32(f64(2).max(f64(5)))), 5);
});

test("f64 clamp: clamp(5, 0, 3) = 3", async () => {
  allEqual(await gen(() => f32(f64(5).clamp(f64(0), f64(3)))), 3);
});

test("f64 lt drives select: 2 < 3 ? 1 : 0 = 1", async () => {
  allEqual(await gen(() => select(f64(2).lt(f64(3)), f32(1), f32(0))), 1);
});

test("f64 gt drives select: 2 > 3 ? 1 : 0 = 0", async () => {
  allEqual(await gen(() => select(f64(2).gt(f64(3)), f32(1), f32(0))), 0);
});

test("f64 eq drives select: 3 == 3 ? 1 : 0 = 1", async () => {
  allEqual(await gen(() => select(f64(3).eq(f64(3)), f32(1), f32(0))), 1);
});

test("f64 lte drives select: 3 <= 3 ? 1 : 0 = 1", async () => {
  allEqual(await gen(() => select(f64(3).lte(f64(3)), f32(1), f32(0))), 1);
});

test("f64 gte drives select: 3 >= 4 ? 1 : 0 = 0", async () => {
  allEqual(await gen(() => select(f64(3).gte(f64(4)), f32(1), f32(0))), 0);
});
