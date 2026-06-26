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

import { audioOutput, state } from "../../dsl/declarations.ts";
import { bool, f32, f64, i32, i64, num } from "../../dsl/constructors.ts";
import { SAMPLES_PER_BLOCK } from "../../dsl/constants.ts";
import { forSample } from "../../dsl/loop.ts";
import { clamp, select } from "../../dsl/primitives.ts";
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

// max / min / clamp on integer operands must lower to integer compare+select,
// NOT f32.max / f32.min (which would be invalid WASM with i32/i64 operands).
test("i32 max: max(3, 7) = 7 (integer compare+select, not f32.max)", async () => {
  allEqual(await gen(() => f32(i32(3).max(i32(7)))), 7);
});

test("i32 min: min(3, 7) = 3 (integer compare+select)", async () => {
  allEqual(await gen(() => f32(i32(3).min(i32(7)))), 3);
});

test("i32 clamp: clamp(x, 0, 5) saturates (9→5, -2→0, 3→3)", async () => {
  allEqual(await gen(() => f32(i32(9).clamp(i32(0), i32(5)))), 5);
  allEqual(await gen(() => f32(i32(-2).clamp(i32(0), i32(5)))), 0);
  allEqual(await gen(() => f32(i32(3).clamp(i32(0), i32(5)))), 3);
});

test("i64 max/min: max(3n, 7n) = 7, min = 3 (integer compare+select)", async () => {
  allEqual(await gen(() => f32(i64(3n).max(i64(7n)))), 7);
  allEqual(await gen(() => f32(i64(3n).min(i64(7n)))), 3);
});

// "type ⟺ works": a numeric op that mixes two CONCRETE scalar-typed nodes (here
// i32 and f32) previously lowered an i32 op fed an f32 operand → invalid WASM that
// only surfaced as a raw validator error (`i32.lt_s expected type i32, found f32`)
// the author could not act on. It must fail at build with a readable unworklet
// error that names the op + the mismatched types. (Number literals still lift to a
// sibling's type — only typed-node-vs-typed-node mismatches error.)
test("mixing scalar types in clamp fails with a readable unworklet error, not raw WASM", async () => {
  // The throw may surface either while tracing the body or during compile, so wrap
  // both in one async assertion. The message must name the op (`clamp`) and the two
  // mismatched types — NOT leak a raw WASM validator error.
  await expect(async () => {
    const proc = defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const iv = state.i32(0).named("iv");
      const fv = state.f32(0).named("fv");
      return {
        process: () => {
          forSample((s) => {
            out
              .ch(0)
              .at(s)
              .write(f32(clamp(iv.read(), 0, fv.read())));
          });
        },
      };
    });
    await render(proc);
  }).rejects.toThrow(/unworklet:[\s\S]*clamp[\s\S]*(i32|f32)/i);
});

// abs is meaningful on integers and lowers to select(x < 0, -x, x), not f32.abs.
test("i32/i64 abs: |-7| = 7 (integer select-based, not f32.abs)", async () => {
  allEqual(await gen(() => f32(i32(-7).abs())), 7);
  allEqual(await gen(() => f32(i32(7).abs())), 7);
  allEqual(await gen(() => f32(i64(-7n).abs())), 7);
});

// Float-only math (sqrt/floor/ceil/frac + transcendentals) is restricted to f32/f64:
// calling these methods on integer nodes is a compile-time type error. abs is allowed on integers.
type IsNever<X> = [X] extends [never] ? true : false;
function expectTrue<_T extends true>(): void {}
function expectFalse<_T extends false>(): void {}
test("float-only math is a type error on integer nodes; abs is allowed on integers (type contract)", () => {
  expectTrue<IsNever<Node<"i32">["sin"]>>();
  expectTrue<IsNever<Node<"i32">["sqrt"]>>();
  expectTrue<IsNever<Node<"i32">["floor"]>>();
  expectTrue<IsNever<Node<"i64">["exp"]>>();
  expectFalse<IsNever<Node<"f32">["sin"]>>(); // f32 is allowed
  expectFalse<IsNever<Node<"i32">["abs"]>>(); // integer abs is allowed
  expect(true).toBe(true);
});

// arithmetic / comparison / min / max are restricted to numeric scalars (plus add/sub/mul/div on f32x4):
// calling these methods on a bool node is a compile-time type error.
test("arithmetic/comparison/min/max are type errors on bool nodes; numeric and f32x4 are allowed (type contract)", () => {
  expectTrue<IsNever<Node<"bool">["add"]>>();
  expectTrue<IsNever<Node<"bool">["mul"]>>();
  expectTrue<IsNever<Node<"bool">["neg"]>>();
  expectTrue<IsNever<Node<"bool">["eq"]>>();
  expectTrue<IsNever<Node<"bool">["max"]>>();
  expectFalse<IsNever<Node<"i32">["add"]>>(); // i32 numeric is allowed
  expectFalse<IsNever<Node<"f32x4">["add"]>>(); // f32x4 SIMD is allowed
  expectFalse<IsNever<Node<"i32">["max"]>>(); // integer max is allowed
  expect(true).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────
// f64 transcendental (Stage 1b-B) — f32-bridge: the f64 builder demotes to f32,
// calls the shared (f32)->f32 polynomial, then promotes back. Accuracy is
// f32-limited (~1e-4, Q17 uniform approximate-math), so assertions use a
// 3-digit tolerance. Observed via f32(...) at the output.
// ─────────────────────────────────────────────────────────────────────────

test("f64 sin: sin(π/2) ≈ 1", async () => {
  approx(await gen(() => f32(f64(Math.PI / 2).sin())), 1, 3);
});

test("f64 sin: sin(0) ≈ 0", async () => {
  approx(await gen(() => f32(f64(0).sin())), 0, 3);
});

test("f64 cos: cos(0) ≈ 1", async () => {
  approx(await gen(() => f32(f64(0).cos())), 1, 3);
});

test("f64 cos: cos(π) ≈ -1", async () => {
  approx(await gen(() => f32(f64(Math.PI).cos())), -1, 3);
});

test("f64 tan: tan(π/4) ≈ 1", async () => {
  approx(await gen(() => f32(f64(Math.PI / 4).tan())), 1, 3);
});

test("f64 exp: exp(1) ≈ e", async () => {
  approx(await gen(() => f32(f64(1).exp())), Math.E, 3);
});

test("f64 exp: exp(0) ≈ 1", async () => {
  approx(await gen(() => f32(f64(0).exp())), 1, 3);
});

test("f64 log: log(e) ≈ 1", async () => {
  approx(await gen(() => f32(f64(Math.E).log())), 1, 3);
});

test("f64 log: log(1) ≈ 0", async () => {
  approx(await gen(() => f32(f64(1).log())), 0, 3);
});

test("f64 tanh: tanh(0) ≈ 0", async () => {
  approx(await gen(() => f32(f64(0).tanh())), 0, 3);
});

test("f64 tanh: tanh(10) ≈ 1 (saturates)", async () => {
  approx(await gen(() => f32(f64(10).tanh())), 1, 3);
});

// ─────────────────────────────────────────────────────────────────────────
// i64 path (Stage 1c) — BigInt-only construction (Q33-c: no implicit number
// lift). Observed by narrowing i64 → i32 (wrap, low 32 bits) → f32, or by
// converting i64 → f32 directly when the full 64-bit magnitude must survive.
// ─────────────────────────────────────────────────────────────────────────

test("i64 literal: f32(i32(i64(42n))) is the constant 42", async () => {
  allEqual(await gen(() => f32(i32(i64(42n)))), 42);
});

test("i64 add: 7 + 10 = 17", async () => {
  allEqual(await gen(() => f32(i32(i64(7n).add(i64(10n))))), 17);
});

test("i64 sub: 10 - 3 = 7", async () => {
  allEqual(await gen(() => f32(i32(i64(10n).sub(i64(3n))))), 7);
});

test("i64 mul: 6 * 7 = 42", async () => {
  allEqual(await gen(() => f32(i32(i64(6n).mul(i64(7n))))), 42);
});

test("i64 div: 17 / 5 = 3 (truncating signed division)", async () => {
  allEqual(await gen(() => f32(i32(i64(17n).div(i64(5n))))), 3);
});

test("i64 div: -17 / 5 = -3 (truncation toward zero)", async () => {
  allEqual(await gen(() => f32(i32(i64(-17n).div(i64(5n))))), -3);
});

test("i64 mod: 17 % 5 = 2 (signed remainder)", async () => {
  allEqual(await gen(() => f32(i32(i64(17n).mod(i64(5n))))), 2);
});

test("i64 mod: -17 % 5 = -2 (sign follows the dividend)", async () => {
  allEqual(await gen(() => f32(i32(i64(-17n).mod(i64(5n))))), -2);
});

test("i64 neg: -(5) = -5", async () => {
  allEqual(await gen(() => f32(i32(i64(5n).neg()))), -5);
});

// 64-bit width proof: 100000 * 100000 = 1e10 survives in i64 (exactly
// representable in f32: 1e10 = 9765625 · 2^10), whereas the same product in
// i32 would wrap to 1410065408. Observed via i64 → f32 (full magnitude).
test("i64 mul exceeds i32 range: 100000 * 100000 = 1e10", async () => {
  allEqual(await gen(() => f32(i64(100000n).mul(i64(100000n)))), 1e10);
});

// 64-bit division proof: 1e10 / 1e9 = 10 needs the full operands; truncated to
// i32 the operands collapse (1e10 → 1410065408, 1e9 → 1e9) and give 1.
test("i64 div exceeds i32 range: 1e10 / 1e9 = 10", async () => {
  allEqual(await gen(() => f32(i32(i64(10000000000n).div(i64(1000000000n))))), 10);
});

test("i64 lt drives select: 3 < 5 ? 1 : 0 = 1", async () => {
  allEqual(await gen(() => select(i64(3n).lt(i64(5n)), f32(1), f32(0))), 1);
});

test("i64 gt drives select: 3 > 5 ? 1 : 0 = 0", async () => {
  allEqual(await gen(() => select(i64(3n).gt(i64(5n)), f32(1), f32(0))), 0);
});

test("i64 eq drives select: 5 == 5 ? 1 : 0 = 1", async () => {
  allEqual(await gen(() => select(i64(5n).eq(i64(5n)), f32(1), f32(0))), 1);
});

test("i64 lte drives select: 5 <= 5 ? 1 : 0 = 1", async () => {
  allEqual(await gen(() => select(i64(5n).lte(i64(5n)), f32(1), f32(0))), 1);
});

test("i64 gte drives select: 3 >= 5 ? 1 : 0 = 0", async () => {
  allEqual(await gen(() => select(i64(3n).gte(i64(5n)), f32(1), f32(0))), 0);
});

test("convert i64 → f64 → f32: f64(i64(2n**33n)) survives past 2^32", async () => {
  allEqual(await gen(() => f32(f64(i64(2n ** 33n)))), 2 ** 33);
});

// i64 literal survives the store → memory → load round-trip at full 64-bit
// width: 2^40 + 7 stored, loaded, wrapped to i32 = 7 (low 32 bits; 2^40 mod
// 2^32 = 0). An i32 slot could never have held the 2^40 component.
test("i64 state round-trip: store 2^40 + 7, load → wrap to i32 = 7", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const acc = state.i64(0n);
    return {
      process: () => {
        acc.write(i64(2n ** 40n + 7n));
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(f32(i32(acc.read())));
        });
      },
    };
  });
  const { outputs } = await render(proc);
  allEqual(outputs.main![0]!, 7);
});

// ─────────────────────────────────────────────────────────────────────────
// bool constructor + num() chain-start helper (Stage 1d). `bool(v)` lifts a JS
// boolean to the internal i32 (0/1) representation; `num(v)` is the literal-
// leading chain helper (Q77) — a numeric `num` is a loose literal whose type is
// resolved from the chain's typed sibling (else f32), a boolean `num` is a bool.
// ─────────────────────────────────────────────────────────────────────────

test("bool(true) drives select → then branch", async () => {
  allEqual(await gen(() => select(bool(true), f32(7), f32(8))), 7);
});

test("bool(false) drives select → else branch", async () => {
  allEqual(await gen(() => select(bool(false), f32(7), f32(8))), 8);
});

test("num(1).add(f32(0.5)) = 1.5 (loose literal lifts to the f32 sibling)", async () => {
  allEqual(await gen(() => num(1).add(f32(0.5))), 1.5);
});

test("num(1).sub(f32(0.25)).mul(f32(2)) = 1.5 (dry/wet style chain start)", async () => {
  allEqual(await gen(() => num(1).sub(f32(0.25)).mul(f32(2))), 1.5);
});

test("num(2).mul(f32(3)) = 6", async () => {
  allEqual(await gen(() => num(2).mul(f32(3))), 6);
});

test("num(5).neg() = -5 (no sibling → f32 default)", async () => {
  allEqual(await gen(() => num(5).neg()), -5);
});

test("num(true) drives select → then branch (boolean num is a bool node)", async () => {
  allEqual(await gen(() => select(num(true), f32(1), f32(0))), 1);
});

test("num(false) drives select → else branch", async () => {
  allEqual(await gen(() => select(num(false), f32(1), f32(0))), 0);
});

test("same-type constructor is a no-op: f32(f32(0.5)) = 0.5", async () => {
  allEqual(await gen(() => f32(f32(0.5))), 0.5);
});

// A `num` whose type is fixed by context (here an i32-typed binding) lifts to
// that type when it meets a typed sibling: 10 + 5 = 15 in integer arithmetic.
test("num infers i32 from a typed sibling: num(10).add(i32(5)) = 15", async () => {
  const out = await gen(() => {
    const base: Node<"i32"> = num(10);
    return f32(base.add(i32(5)));
  });
  allEqual(out, 15);
});
