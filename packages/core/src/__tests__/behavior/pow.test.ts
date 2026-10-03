/**
 * Black-box behavior: `pow(base, exponent)` against JavaScript's `**`.
 *
 * Each test renders a real processor through the public DSL surface and reads
 * output PCM only. The emitted WASM replaces a non-finite output sample with 0,
 * so every result is written twice: its value (0 when not finite) on channel 0
 * and its kind (finite / NaN / +Inf / -Inf) on channel 1. Bases and exponents
 * arrive on the two input channels, one pair per sample.
 */

import { expect, test } from "vite-plus/test";

import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { f32, f64, i32 } from "../../dsl/constructors.ts";
import { audioInput, audioOutput } from "../../dsl/declarations.ts";
import { forSample } from "../../dsl/loop.ts";
import { eq, not, or, pow, select } from "../../dsl/primitives.ts";
import { defineProcessor } from "../../processor.ts";
import type { Node } from "../../types.ts";

import { render } from "./render.ts";

const KINDS = ["finite", "nan", "+inf", "-inf"] as const;
type Outcome = { value: number; kind: (typeof KINDS)[number] };
type Pair = readonly [base: number, exponent: number];

/** Render `build(base, exponent)` once per pair and classify each result. */
async function run(
  pairs: readonly Pair[],
  build: (base: Node<"f32">, exponent: Node<"f32">) => Node<"f32"> = pow,
): Promise<Outcome[]> {
  const blocks = Math.ceil(pairs.length / SAMPLES_PER_BLOCK);
  const base = new Float32Array(blocks * SAMPLES_PER_BLOCK);
  const exponent = new Float32Array(blocks * SAMPLES_PER_BLOCK);
  pairs.forEach(([b, e], k) => {
    base[k] = b;
    exponent[k] = e;
  });
  const proc = defineProcessor(() => {
    const input = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 2, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          const r = build(input.ch(0).at(i), input.ch(1).at(i));
          const nan = not(eq(r, r));
          const posInf = eq(r, Number.POSITIVE_INFINITY);
          const negInf = eq(r, Number.NEGATIVE_INFINITY);
          out
            .ch(0)
            .at(i)
            .write(select(or(nan, or(posInf, negInf)), 0, r));
          out
            .ch(1)
            .at(i)
            .write(select(nan, 1, select(posInf, 2, select(negInf, 3, 0))));
        });
      },
    };
  });
  const { outputs } = await render(proc, { blocks, inputs: { main: [base, exponent] } });
  const [values, kinds] = outputs.main!;
  return pairs.map((_, k) => ({ value: values![k]!, kind: KINDS[kinds![k]!]! }));
}

/** JavaScript's `**` on the f32-rounded operands, rounded back to f32. */
function js(base: number, exponent: number): Outcome {
  const v = Math.fround(Math.fround(base) ** Math.fround(exponent));
  if (Number.isNaN(v)) return { value: 0, kind: "nan" };
  if (v === Number.POSITIVE_INFINITY) return { value: 0, kind: "+inf" };
  if (v === Number.NEGATIVE_INFINITY) return { value: 0, kind: "-inf" };
  return { value: v, kind: "finite" };
}

test("zero, infinite and NaN operands give exactly what JavaScript's ** gives", async () => {
  const pairs: Pair[] = [
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [0, 0],
    [-3, -0],
    [2, Number.NaN],
    [Number.NaN, 2],
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    [-1, Number.NEGATIVE_INFINITY],
    [0.5, Number.POSITIVE_INFINITY],
    [2, Number.POSITIVE_INFINITY],
    [0.5, Number.NEGATIVE_INFINITY],
    [2, Number.NEGATIVE_INFINITY],
    [-2, Number.POSITIVE_INFINITY],
    [-0.5, Number.POSITIVE_INFINITY],
    [0, 2],
    [0, -2],
    [-0, 3],
    [-0, -3],
    [0, 0.5],
    [0, -0.5],
    [-0, 0.5],
    [-0, -0.5],
    [0, 300],
    [-0, -301],
    [Number.POSITIVE_INFINITY, 2],
    [Number.POSITIVE_INFINITY, -2],
    [Number.POSITIVE_INFINITY, 0.5],
    [Number.NEGATIVE_INFINITY, 3],
    [Number.NEGATIVE_INFINITY, 2],
    [Number.NEGATIVE_INFINITY, -3],
    [Number.NEGATIVE_INFINITY, 0.5],
    [Number.NEGATIVE_INFINITY, -0.5],
    [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  ];
  expect(await run(pairs)).toEqual(pairs.map(([b, e]) => js(b, e)));
});

test("a negative base with a fractional exponent is NaN, as in JavaScript", async () => {
  const pairs: Pair[] = [
    [-8, 1 / 3],
    [-2, 0.5],
    [-2, -1.5],
    [-0.25, 2.5],
  ];
  expect(await run(pairs)).toEqual(pairs.map(() => ({ value: 0, kind: "nan" })));
});

test("integral exponents give the exact result whenever JavaScript's is exact", async () => {
  const pairs: Pair[] = [
    [10, 2],
    [2, 10],
    [-3, 3],
    [-2, 4],
    [0.5, -2],
    [7, 1],
    [7, 0],
    [-1.5, 2],
    [2, -3],
    [3, 5],
    [-2, 7],
    [1.5, 3],
    [0.25, 3],
    [2, 24],
    [2, -24],
    [-0.5, -3],
    [100, 3],
    [10, 7],
    [10, -1],
    [-2, 127],
  ];
  expect(await run(pairs)).toEqual(pairs.map(([b, e]) => js(b, e)));
});

test("squaring equals multiplying the value by itself", async () => {
  const xs = [0.3, -0.7, 1.1, -0.123456, 0.999, 3.14159, -42.5, 1e-3];
  const got = await run(xs.map((x) => [x, 2] as const));
  expect(got).toEqual(
    xs.map((x) => ({ value: Math.fround(Math.fround(x) * Math.fround(x)), kind: "finite" })),
  );
});

test("fractional exponents track JavaScript within 1e-4 relative", async () => {
  const bases = [1e-3, 0.01, 0.1, 0.5, 0.9, 1, 1.1, 2, 3, 10, 100, 1000];
  const exponents = [-3.5, -2.25, -1.5, -0.5, 0.25, 0.5, 1.5, 2.75, 3.3];
  const pairs = bases.flatMap((b) => exponents.map((e) => [b, e] as const));
  const got = await run(pairs);
  pairs.forEach(([b, e], k) => {
    const want = js(b, e).value;
    expect(got[k]!.kind, `${b} ** ${e}`).toBe("finite");
    expect(Math.abs(got[k]!.value - want) / want, `${b} ** ${e}`).toBeLessThan(1e-4);
  });
});

test("the dB-to-gain curve 10 ** (dB / 20) tracks JavaScript within 1e-4 relative", async () => {
  const dbs = [-96, -60, -40, -20, -12, -6, -3, -1, 0, 1, 3, 6, 12];
  const got = await run(dbs.map((db) => [10, db / 20] as const));
  dbs.forEach((db, k) => {
    const want = js(10, db / 20).value;
    expect(Math.abs(got[k]!.value - want) / want, `${db} dB`).toBeLessThan(1e-4);
  });
});

test("an odd integral exponent beyond the exact range keeps a negative base's sign", async () => {
  const pairs: Pair[] = [
    [-1.01, 301],
    [-1.01, 300],
    [-0.99, -401],
    [-0.99, -400],
  ];
  const got = await run(pairs);
  pairs.forEach(([b, e], k) => {
    const want = js(b, e).value;
    expect(Math.sign(got[k]!.value), `${b} ** ${e}`).toBe(Math.sign(want));
    expect(Math.abs(got[k]!.value - want) / Math.abs(want), `${b} ** ${e}`).toBeLessThan(1e-4);
  });
});

test("the method form x.pow(y) equals pow(x, y)", async () => {
  const pairs: Pair[] = [
    [10, -0.3],
    [-2, 3],
    [0.5, 2.5],
    [Number.NaN, 0],
  ];
  expect(await run(pairs, (b, e) => b.pow(e))).toEqual(await run(pairs));
});

test("pow on f64 operands tracks JavaScript within 1e-4 relative", async () => {
  const pairs: Pair[] = [
    [10, -0.3],
    [2, 10],
    [-3, 3],
    [0.5, 2.5],
  ];
  const got = await run(pairs, (b, e) => f32(pow(f64(b), f64(e))));
  pairs.forEach(([b, e], k) => {
    const want = js(b, e).value;
    expect(Math.abs(got[k]!.value - want) / Math.abs(want), `${b} ** ${e}`).toBeLessThan(1e-4);
  });
});

test("an integer operand is refused with a message that names the conversion", async () => {
  await expect(run([[2, 3]], () => f32(pow(i32(2) as unknown as Node<"f32">, 3)))).rejects.toThrow(
    /pow\(\) needs f32 or f64 operands, got i32.*f32\(x\)/,
  );
});
