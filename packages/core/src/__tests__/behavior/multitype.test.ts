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
import { f32, i32 } from "../../dsl/constructors.ts";
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
