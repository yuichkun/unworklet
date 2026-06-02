/**
 * Operator-precedence hunter (adversarial). The sugar pass recurses bottom-up so
 * JS parse precedence/associativity MUST be preserved when infix operators on DSP
 * values lower to chain primitives. Two oracles:
 *
 * - `renderLowered` + a pure-JS reference value — the high-confidence semantic
 *   probe. Prime-ish distinct inputs distinguish a wrong grouping (e.g. `a+b*c`
 *   vs `(a+b)*c` give different numbers). f32-exact integer-ish values keep the
 *   JS reference equal to the WASM f32 math, so `toBeCloseTo` needs no slack.
 * - `expectSameLowering` against a hand-written chain-DSL `.uwk.ts` (ground truth,
 *   no operator sugar) — structural equivalence of the lowered graph.
 *
 * A build-time `number op number` const-fold (e.g. `N * 2`, `N - M`) MUST stay JS
 * and never lower; the type-directed dispatch (`isDspExpr`) is asserted here too.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;

/** A minimal mono processor: declarations + a per-sample body. */
function mono(decls: string, body: string): string {
  return `
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => {
  forSample((i) => {
${body}
  });
});
`;
}

/** Render a mono body with a constant input and return output[0][0]. */
async function firstOut(decls: string, body: string, inval: number): Promise<number> {
  const x = new Float32Array(128).fill(inval);
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: 128 / SR,
    inputs: { main: [x] },
  });
  return r.outputs.main![0]![0]!;
}

const W = (expr: string): string => `out.ch(0).at(i).write(${expr});`;
const A = "input.ch(0).at(i)";

// ─────────────────────────────────────────────────────────────────────────
// 1. Multiplicative binds tighter than additive (a + b * c)
// ─────────────────────────────────────────────────────────────────────────

test("a + b*c: mul binds tighter than add (3 + 3*2 = 9, not (3+3)*2 = 12)", async () => {
  expect(await firstOut("", W(`${A} + ${A} * 2`), 3)).toBeCloseTo(9, 5);
});

test("a*b + c: mul binds tighter than add on the left (3*2 + 3 = 9, not 3*(2+3) = 15)", async () => {
  expect(await firstOut("", W(`${A} * 2 + ${A}`), 3)).toBeCloseTo(9, 5);
});

test("a - b*c: mul binds tighter than sub (10 - 10*2 = -10, not (10-10)*2 = 0)", async () => {
  expect(await firstOut("", W(`${A} - ${A} * 2`), 10)).toBeCloseTo(-10, 5);
});

test("a*b + c*d: two products then add (2*3 + 2*4 = 14, not 2*(3+2)*4 = 40)", async () => {
  expect(await firstOut("", W(`${A}*3 + ${A}*4`), 2)).toBeCloseTo(14, 5);
});

test("a + b/c: div binds tighter than add (10 + 10/2 = 15, not (10+10)/2 = 10)", async () => {
  expect(await firstOut("", W(`${A} + ${A} / 2`), 10)).toBeCloseTo(15, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Left-associativity of same-precedence chains
// ─────────────────────────────────────────────────────────────────────────

test("a - b - c left-assoc (10 - 3 - 2 = 5, not 10 - (3-2) = 9)", async () => {
  expect(await firstOut("", W(`${A} - 3 - 2`), 10)).toBeCloseTo(5, 5);
});

test("a - b + c left-assoc (10 - 3 + 2 = 9, not 10 - (3+2) = 5)", async () => {
  expect(await firstOut("", W(`${A} - 3 + 2`), 10)).toBeCloseTo(9, 5);
});

test("a + b - c left-assoc (10 + 3 - 2 = 11, not 10 + (3-2) = 11 — distinguish via 10+3-8)", async () => {
  // 10 + 3 - 8 = 5 left-assoc; 10 + (3 - 8) = 5 too, so pick asymmetric: 10 - 3 + 8.
  expect(await firstOut("", W(`${A} - 3 + 8`), 10)).toBeCloseTo(15, 5);
});

test("a / b / c left-assoc (12 / 3 / 2 = 2, not 12 / (3/2) = 8)", async () => {
  expect(await firstOut("", W(`${A} / 3 / 2`), 12)).toBeCloseTo(2, 5);
});

test("a / b * c left-assoc (12 / 3 * 2 = 8, not 12 / (3*2) = 2)", async () => {
  expect(await firstOut("", W(`${A} / 3 * 2`), 12)).toBeCloseTo(8, 5);
});

test("a * b / c value (12 * 3 / 2 = 18) — mul/div regroup to the same real, so grouping is checked structurally below", async () => {
  // Note: (a*b)/c == a*(b/c) in exact arithmetic, so this value alone cannot
  // distinguish associativity — the structural oracle (div(mul(a,b),c)) does.
  expect(await firstOut("", W(`${A} * 3 / 2`), 12)).toBeCloseTo(18, 5);
});

test("a * b / c lowers structurally to div(mul(a, b), c) (left-assoc grouping)", async () => {
  await expectSameLowering(mono("", W(`${A} * 3 / 2`)), mono("", W(`${A}.mul(3).div(2)`)));
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Modulo precedence (same tier as * and /)
// ─────────────────────────────────────────────────────────────────────────

test("a % b + c: mod binds tighter than add (10 % 3 + 1 = 2, not 10 % (3+1) = 2 — use +5)", async () => {
  // 10 % 3 + 5 = 1 + 5 = 6 left; 10 % (3+5) = 10 % 8 = 2 — distinguishes.
  expect(await firstOut("", W(`${A} % 3 + 5`), 10)).toBeCloseTo(6, 5);
});

test("a + b % c: mod binds tighter than add on the right (10 + 10%3 = 11, not (10+10)%3 = 2)", async () => {
  expect(await firstOut("", W(`${A} + ${A} % 3`), 10)).toBeCloseTo(11, 5);
});

test("a % b % c left-assoc (17 % 7 % 2 = 1, not 17 % (7%2) = 0)", async () => {
  // 17 % 7 = 3; 3 % 2 = 1 left. 17 % (7 % 2) = 17 % 1 = 0 — distinguishes.
  expect(await firstOut("", W(`${A} % 7 % 2`), 17)).toBeCloseTo(1, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Unary minus / logical not binding
// ─────────────────────────────────────────────────────────────────────────

test("-a * b: unary minus binds tighter than mul (-(3) * 4 = -12, not -(3*4) — same here, use -a*b distinct)", async () => {
  // -3 * 4 = -12; both groupings equal for single operand, so verify sign + magnitude.
  expect(await firstOut("", W(`-${A} * 4`), 3)).toBeCloseTo(-12, 5);
});

test("a * -b: unary minus on the right operand (3 * -(3) = -9)", async () => {
  expect(await firstOut("", W(`${A} * -${A}`), 3)).toBeCloseTo(-9, 5);
});

test("-a + b: unary minus binds tighter than add (-(3) + 3 = 0, not -(3+3) = -6)", async () => {
  expect(await firstOut("", W(`-${A} + ${A}`), 3)).toBeCloseTo(0, 5);
});

test("-(a + b): explicit paren forces negate of the sum (-(3+3) = -6)", async () => {
  expect(await firstOut("", W(`-(${A} + ${A})`), 3)).toBeCloseTo(-6, 5);
});

test("-(-a): double negation (-(-(3)) = 3)", async () => {
  expect(await firstOut("", W(`-(-${A})`), 3)).toBeCloseTo(3, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Comparison + ternary precedence (relational looser than additive)
// ─────────────────────────────────────────────────────────────────────────

test("a + b > c ? x : y — additive binds tighter than relational, no parens (5+1>5 → 100)", async () => {
  expect(await firstOut("", W(`${A} + 1 > 5 ? 100 : 0`), 5)).toBeCloseTo(100, 5);
});

test("a + b > c ? x : y — false branch when sum not over threshold (3+1>5 false → 0)", async () => {
  expect(await firstOut("", W(`${A} + 1 > 5 ? 100 : 0`), 3)).toBeCloseTo(0, 5);
});

test("a * b > c ? x : y — mul binds tighter than relational (2*3>5 → 7)", async () => {
  expect(await firstOut("", W(`${A} * 3 > 5 ? 7 : 0`), 2)).toBeCloseTo(7, 5);
});

test("!(a > b) ? x : y — not of a comparison, true when not over (3>5 false → !false → 1)", async () => {
  expect(await firstOut("", W(`!(${A} > 5) ? 1 : 0`), 3)).toBeCloseTo(1, 5);
});

test("!(a > b) ? x : y — false when over (8>5 true → !true → 0)", async () => {
  expect(await firstOut("", W(`!(${A} > 5) ? 1 : 0`), 8)).toBeCloseTo(0, 5);
});

test("ternary result feeds arithmetic: (a>5?2:1) * 10 — paren ternary then mul (8>5 → 2*10 = 20)", async () => {
  expect(await firstOut("", W(`(${A} > 5 ? 2 : 1) * 10`), 8)).toBeCloseTo(20, 5);
});

test("nested ternary chooses inner branch (a=12 → a>5 → a>10 → 2)", async () => {
  expect(await firstOut("", W(`${A} > 5 ? (${A} > 10 ? 2 : 1) : 0`), 12)).toBeCloseTo(2, 5);
});

test("nested ternary chooses inner else (a=8 → a>5 → not a>10 → 1)", async () => {
  expect(await firstOut("", W(`${A} > 5 ? (${A} > 10 ? 2 : 1) : 0`), 8)).toBeCloseTo(1, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Explicit parens override default precedence
// ─────────────────────────────────────────────────────────────────────────

test("(a + b) * c: paren forces add before mul ((4+1)*2 = 10, not 4 + 1*2 = 6)", async () => {
  expect(await firstOut("", W(`(${A} + 1) * 2`), 4)).toBeCloseTo(10, 5);
});

test("(a + b) * (a - c): product of two sums ((5+2)*(5-1) = 28)", async () => {
  expect(await firstOut("", W(`(${A} + 2) * (${A} - 1)`), 5)).toBeCloseTo(28, 5);
});

test("deep nesting ((a + b) * c - d) / e — (((4+1)*2 - 3)/7) = 1", async () => {
  // (4+1)=5, *2=10, -3=7, /7=1
  expect(await firstOut("", W(`((${A} + 1) * 2 - 3) / 7`), 4)).toBeCloseTo(1, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Build-time const-fold MUST stay JS (type-directed dispatch boundary)
// ─────────────────────────────────────────────────────────────────────────

test("N*2 + a: N*2 (number op number) stays JS, only outer add lowers (8*2 + 1 = 17)", async () => {
  expect(await firstOut("const N = 8;", W(`N * 2 + ${A}`), 1)).toBeCloseTo(17, 5);
});

test("a + N - M: const operands N,M ride as bare JS numbers, left-assoc (1 + 10 - 3 = 8)", async () => {
  expect(await firstOut("const N = 10;\nconst M = 3;", W(`${A} + N - M`), 1)).toBeCloseTo(8, 5);
});

test("a + (N - M): pure-const subexpr (N-M) stays JS, then one add (1 + (10-3) = 8)", async () => {
  expect(await firstOut("const N = 10;\nconst M = 3;", W(`${A} + (N - M)`), 1)).toBeCloseTo(8, 5);
});

test("a * (N + 1): const sum (N+1) stays JS, scales the node (5 * (2+1) = 15)", async () => {
  expect(await firstOut("const N = 2;", W(`${A} * (N + 1)`), 5)).toBeCloseTo(15, 5);
});

test("Math.round build-const + a: K stays a JS number, add lowers (round(3.7)=4, 4+1 = 5)", async () => {
  expect(await firstOut("const K = Math.round(3.7);", W(`K + ${A}`), 1)).toBeCloseTo(5, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Literal-lift type: f32 node + fractional literal stays f32-correct
// ─────────────────────────────────────────────────────────────────────────

test("a + 0.5: fractional literal lifts to f32, fraction preserved (1 + 0.5 = 1.5)", async () => {
  expect(await firstOut("", W(`${A} + 0.5`), 1)).toBeCloseTo(1.5, 5);
});

test("a * 0.25 + 0.125: chained fractional f32 math (8*0.25 + 0.125 = 2.125)", async () => {
  expect(await firstOut("", W(`${A} * 0.25 + 0.125`), 8)).toBeCloseTo(2.125, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Integer-typed precedence: i32 div truncates, i32 mod, left-assoc
// ─────────────────────────────────────────────────────────────────────────

test("i32 div truncates (i32(7)/i32(2) = 3, not 3.5)", async () => {
  const r = await renderLowered(mono("", W(`f32(i32(7) / i32(2))`)), {
    sampleRate: SR,
    duration: 128 / SR,
    inputs: { main: [new Float32Array(128).fill(0)] },
  });
  expect(r.outputs.main![0]![0]).toBeCloseTo(3, 5);
});

test("i32 mod then add precedence (i32(10) % i32(3) + i32(1) = 2)", async () => {
  const r = await renderLowered(mono("", W(`f32(i32(10) % i32(3) + i32(1))`)), {
    sampleRate: SR,
    duration: 128 / SR,
    inputs: { main: [new Float32Array(128).fill(0)] },
  });
  expect(r.outputs.main![0]![0]).toBeCloseTo(2, 5);
});

test("f32 div keeps fraction (f32(7)/f32(2) = 3.5) — contrast with i32 trunc", async () => {
  const r = await renderLowered(mono("", W(`f32(7) / f32(2)`)), {
    sampleRate: SR,
    duration: 128 / SR,
    inputs: { main: [new Float32Array(128).fill(0)] },
  });
  expect(r.outputs.main![0]![0]).toBeCloseTo(3.5, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Structural equivalence vs hand-written chain DSL (ground truth)
// ─────────────────────────────────────────────────────────────────────────

test("a + b*c lowers structurally to add(a, mul(b, c))", async () => {
  await expectSameLowering(mono("", W(`${A} + ${A} * 2`)), mono("", W(`${A}.add(${A}.mul(2))`)));
});

test("(a + b) * c lowers structurally to mul(add(a, b), c)", async () => {
  await expectSameLowering(mono("", W(`(${A} + 1) * 2`)), mono("", W(`${A}.add(1).mul(2)`)));
});

test("a - b - c lowers structurally to sub(sub(a, b), c) (left-assoc)", async () => {
  await expectSameLowering(mono("", W(`${A} - 3 - 2`)), mono("", W(`${A}.sub(3).sub(2)`)));
});

test("a/b/c lowers structurally to div(div(a, b), c) (left-assoc)", async () => {
  await expectSameLowering(mono("", W(`${A} / 3 / 2`)), mono("", W(`${A}.div(3).div(2)`)));
});

test("a*b + c*d lowers structurally to add(mul(a,b), mul(c,d))", async () => {
  await expectSameLowering(
    mono("", W(`${A}*3 + ${A}*4`)),
    mono("", W(`${A}.mul(3).add(${A}.mul(4))`)),
  );
});

test("a + b > c ? x : y lowers structurally to select(gt(add(a,b), c), x, y)", async () => {
  await expectSameLowering(
    mono("", W(`${A} + 1 > 5 ? 100 : 0`)),
    mono("", W(`select(${A}.add(1).gt(5), 100, 0)`)),
  );
});

test("!(a > b) lowers structurally to not(gt(a, b))", async () => {
  await expectSameLowering(
    mono("", W(`(!(${A} > 5)) ? 1 : 0`)),
    mono("", W(`select(not(${A}.gt(5)), 1, 0)`)),
  );
});

test("-a * b lowers structurally to mul(neg(a), b)", async () => {
  await expectSameLowering(mono("", W(`-${A} * 4`)), mono("", W(`${A}.neg().mul(4)`)));
});

test("a != b lowers structurally to not(eq(a, b))", async () => {
  await expectSameLowering(
    mono("", W(`(${A} != 0) ? 1 : 0`)),
    mono("", W(`select(not(${A}.eq(0)), 1, 0)`)),
  );
});

test("N*2 + a: const fold stays JS, only the outer add lowers (structural)", async () => {
  await expectSameLowering(
    mono("const N = 8;", W(`N * 2 + ${A}`)),
    mono("const N = 8;", W(`add(N * 2, ${A})`)),
  );
});
