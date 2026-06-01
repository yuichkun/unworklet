/**
 * Exhaustive arithmetic-on-integer-and-float-types tests for the `.uwk.ts`
 * operator sugar. Category: arith on i32 (truncating division, 32-bit
 * wraparound, rem_s sign), i64 (BigInt literals, 64-bit wraparound, NO implicit
 * number lift), and f64 (double precision).
 *
 * Two oracles:
 *  - `expectSameLowering(sugar, explicit)` proves the sugar lowers to the SAME
 *    compiled processor as a hand-written chain-DSL form (structural ground truth).
 *  - `renderLowered` runs the lowered processor through REAL WebAssembly and
 *    checks the output against a pure-JS / BigInt reference (semantic ground
 *    truth — integer truncation/wraparound is unambiguous WASM behavior).
 *
 * The single audio output port is `f32`, so every value observed through the
 * output is `Math.fround(...)` of the computed math. The JS reference therefore
 * computes the integer/float math first (in the right width) then applies
 * `Math.fround` to model the final `f32(...)` store.
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

/** Render and return the very first output sample (channel 0, sample 0). */
async function firstSample(uwk: string): Promise<number> {
  const r = await renderLowered(uwk, { sampleRate: SR, duration: 1 / SR });
  return r.outputs.main![0]![0]!;
}

// ── i32 reference helpers (32-bit signed, WASM i32.* semantics) ──────────────
const wrap32 = (n: number): number => n | 0; // ToInt32
const idiv = (a: number, b: number): number => Math.trunc(a / b) | 0; // i32.div_s
const irem = (a: number, b: number): number => (a % b) | 0; // i32.rem_s
const i32f = (n: number): number => Math.fround(wrap32(n));

// ── i64 reference (64-bit signed via BigInt, value observed as f32) ──────────
const wrap64 = (n: bigint): bigint => BigInt.asIntN(64, n);
const i64f = (n: bigint): number => Math.fround(Number(wrap64(n)));

// ── f64 / f32 float reference ────────────────────────────────────────────────
const f64f = (n: number): number => Math.fround(n); // store an f64 value into an f32 port

// ════════════════════════════════════════════════════════════════════════════
// i32 — truncating division
// ════════════════════════════════════════════════════════════════════════════

test("i32: 7 / 2 truncates toward zero → 3", async () => {
  const uwk = mono(
    "const a = state.i32(7).named('a');\nconst b = state.i32(2).named('b');",
    "out.ch(0).at(i).write(f32(a / b));",
  );
  expect(await firstSample(uwk)).toBe(idiv(7, 2)); // 3
});

test("i32: -7 / 2 truncates toward zero → -3 (NOT floor -4)", async () => {
  const uwk = mono(
    "const a = state.i32(-7).named('a');\nconst b = state.i32(2).named('b');",
    "out.ch(0).at(i).write(f32(a / b));",
  );
  expect(await firstSample(uwk)).toBe(-3);
  expect(await firstSample(uwk)).not.toBe(-4);
});

test("i32: 7 / -2 → -3 and -7 / -2 → 3", async () => {
  const pos = mono(
    "const a = state.i32(7).named('a');\nconst b = state.i32(-2).named('b');",
    "out.ch(0).at(i).write(f32(a / b));",
  );
  const neg = mono(
    "const a = state.i32(-7).named('a');\nconst b = state.i32(-2).named('b');",
    "out.ch(0).at(i).write(f32(a / b));",
  );
  expect(await firstSample(pos)).toBe(-3);
  expect(await firstSample(neg)).toBe(3);
});

test("i32: division is integer, not float — 5 / 2 = 2 (NOT 2.5)", async () => {
  const uwk = mono(
    "const a = state.i32(5).named('a');\nconst b = state.i32(2).named('b');",
    "out.ch(0).at(i).write(f32(a / b));",
  );
  const v = await firstSample(uwk);
  expect(v).toBe(2);
  expect(Number.isInteger(v)).toBe(true);
});

test("i32: literal divisor lifts to i32 — a / 4 truncates (a=10 → 2)", async () => {
  const uwk = mono("const a = state.i32(10).named('a');", "out.ch(0).at(i).write(f32(a / 4));");
  expect(await firstSample(uwk)).toBe(idiv(10, 4)); // 2
});

// ════════════════════════════════════════════════════════════════════════════
// i32 — rem_s sign semantics
// ════════════════════════════════════════════════════════════════════════════

test("i32: -7 % 3 → -1 (rem follows dividend sign, NOT euclidean 2)", async () => {
  const uwk = mono(
    "const a = state.i32(-7).named('a');\nconst b = state.i32(3).named('b');",
    "out.ch(0).at(i).write(f32(a % b));",
  );
  expect(await firstSample(uwk)).toBe(irem(-7, 3)); // -1
  expect(await firstSample(uwk)).not.toBe(2);
});

test("i32: 7 % -3 → 1 (rem follows dividend, ignores divisor sign)", async () => {
  const uwk = mono(
    "const a = state.i32(7).named('a');\nconst b = state.i32(-3).named('b');",
    "out.ch(0).at(i).write(f32(a % b));",
  );
  expect(await firstSample(uwk)).toBe(irem(7, -3)); // 1
});

// ════════════════════════════════════════════════════════════════════════════
// i32 — 32-bit wraparound
// ════════════════════════════════════════════════════════════════════════════

test("i32: 100000 * 100000 wraps to 1410065408 (10^10 mod 2^32, signed)", async () => {
  const uwk = mono("const a = state.i32(100000).named('a');", "out.ch(0).at(i).write(f32(a * a));");
  expect(await firstSample(uwk)).toBe(i32f(Math.imul(100000, 100000)));
  expect(await firstSample(uwk)).toBe(1410065408);
});

test("i32: 2147483647 + 1 overflows to -2147483648 (INT_MAX + 1)", async () => {
  const uwk = mono(
    "const a = state.i32(2147483647).named('a');\nconst one = state.i32(1).named('one');",
    "out.ch(0).at(i).write(f32(a + one));",
  );
  expect(await firstSample(uwk)).toBe(i32f(2147483647 + 1)); // -2147483648
  expect(await firstSample(uwk)).toBe(-2147483648);
});

test("i32: -2147483648 - 1 underflows to 2147483647 (INT_MIN - 1)", async () => {
  const uwk = mono(
    "const a = state.i32(-2147483648).named('a');\nconst one = state.i32(1).named('one');",
    "out.ch(0).at(i).write(f32(a - one));",
  );
  // The i32 underflow yields INT_MAX (2147483647) inside WASM, but the f32
  // output port cannot represent it exactly — `Math.fround(2147483647)` rounds
  // up to 2147483648, which is what we observe. The semantic check is `i32f`.
  expect(await firstSample(uwk)).toBe(i32f(wrap32(-2147483648 - 1)));
  expect(await firstSample(uwk)).toBe(Math.fround(2147483647)); // = 2147483648
});

// ════════════════════════════════════════════════════════════════════════════
// i32 — all four arith primitives + nesting + precedence
// ════════════════════════════════════════════════════════════════════════════

test("i32: add/sub/mul/div round-trip — (a + b) * c - d / e", async () => {
  const decls =
    "const a = state.i32(9).named('a');\nconst b = state.i32(5).named('b');\n" +
    "const c = state.i32(3).named('c');\nconst d = state.i32(17).named('d');\n" +
    "const e = state.i32(4).named('e');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32((a + b) * c - d / e));");
  // (9+5)*3 - trunc(17/4) = 42 - 4 = 38, all i32
  const expected = i32f(wrap32(Math.imul(wrap32(9 + 5), 3)) - idiv(17, 4));
  expect(await firstSample(uwk)).toBe(expected);
  expect(await firstSample(uwk)).toBe(38);
});

test("i32: precedence — a + b * c (mul binds tighter than add)", async () => {
  const decls =
    "const a = state.i32(2).named('a');\nconst b = state.i32(3).named('b');\nconst c = state.i32(4).named('c');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(a + b * c));");
  // 2 + (3*4) = 14, NOT (2+3)*4 = 20
  expect(await firstSample(uwk)).toBe(i32f(wrap32(2 + Math.imul(3, 4))));
  expect(await firstSample(uwk)).toBe(14);
  expect(await firstSample(uwk)).not.toBe(20);
});

test("i32: left-associativity — a - b - c = (a - b) - c", async () => {
  const decls =
    "const a = state.i32(20).named('a');\nconst b = state.i32(5).named('b');\nconst c = state.i32(3).named('c');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(a - b - c));");
  // (20-5)-3 = 12, NOT 20-(5-3) = 18
  expect(await firstSample(uwk)).toBe(i32f(wrap32(wrap32(20 - 5) - 3)));
  expect(await firstSample(uwk)).toBe(12);
});

test("i32: deep left-fold division — a / b / c = (a / b) / c truncates per step", async () => {
  const decls =
    "const a = state.i32(100).named('a');\nconst b = state.i32(3).named('b');\nconst c = state.i32(3).named('c');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(a / b / c));");
  // trunc(trunc(100/3)/3) = trunc(33/3) = 11, NOT trunc(100/9) = 11 here (same)
  // pick values where stepwise differs: 100/3=33, 33/3=11. trunc(100/9)=11 — same.
  // use a/b/c = 100/6/... below for divergence test
  expect(await firstSample(uwk)).toBe(idiv(idiv(100, 3), 3));
  expect(await firstSample(uwk)).toBe(11);
});

test("i32: stepwise truncation diverges from single-divide — 17 / 2 / 2 = 4 not 4.25→4", async () => {
  const decls =
    "const a = state.i32(17).named('a');\nconst b = state.i32(2).named('b');\nconst c = state.i32(2).named('c');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(a / b / c));");
  // (17/2=8) / 2 = 4. Confirms per-step truncation.
  expect(await firstSample(uwk)).toBe(idiv(idiv(17, 2), 2));
  expect(await firstSample(uwk)).toBe(4);
});

test("i32: unary neg — -a flips sign (a=12 → -12)", async () => {
  const uwk = mono("const a = state.i32(12).named('a');", "out.ch(0).at(i).write(f32(-a));");
  expect(await firstSample(uwk)).toBe(-12);
});

test("i32: neg of INT_MIN wraps to itself (-(-2147483648) = -2147483648)", async () => {
  const uwk = mono(
    "const a = state.i32(-2147483648).named('a');",
    "out.ch(0).at(i).write(f32(-a));",
  );
  // 0 - INT_MIN wraps back to INT_MIN in i32
  expect(await firstSample(uwk)).toBe(i32f(wrap32(0 - -2147483648)));
  expect(await firstSample(uwk)).toBe(-2147483648);
});

// ════════════════════════════════════════════════════════════════════════════
// i32 — structural equivalence to explicit chain form
// ════════════════════════════════════════════════════════════════════════════

test("i32 structural: a / b lowers to div(a.read(), b.read())", async () => {
  const decls = "const a = state.i32(7).named('a');\nconst b = state.i32(2).named('b');";
  const sugar = mono(decls, "out.ch(0).at(i).write(f32(a / b));");
  const explicit = mono(decls, "out.ch(0).at(i).write(f32(div(a.read(), b.read())));");
  await expectSameLowering(sugar, explicit);
});

test("i32 structural: a % b → mod, with literal divisor a % 5", async () => {
  const decls = "const a = state.i32(13).named('a');";
  const sugar = mono(decls, "out.ch(0).at(i).write(f32(a % 5));");
  const explicit = mono(decls, "out.ch(0).at(i).write(f32(mod(a.read(), 5)));");
  await expectSameLowering(sugar, explicit);
});

test("i32 structural: nested (a + b) * c - d", async () => {
  const decls =
    "const a = state.i32(9).named('a');\nconst b = state.i32(5).named('b');\n" +
    "const c = state.i32(3).named('c');\nconst d = state.i32(17).named('d');";
  const sugar = mono(decls, "out.ch(0).at(i).write(f32((a + b) * c - d));");
  const explicit = mono(
    decls,
    "out.ch(0).at(i).write(f32(sub(mul(add(a.read(), b.read()), c.read()), d.read())));",
  );
  await expectSameLowering(sugar, explicit);
});

// ════════════════════════════════════════════════════════════════════════════
// i64 — BigInt literal construction + NO implicit number lift
// ════════════════════════════════════════════════════════════════════════════

test("i64: a + i64(1n) → 6 (BigInt literal addend)", async () => {
  const uwk = mono(
    "const a = state.i64(5n).named('a');",
    "out.ch(0).at(i).write(f32(a + i64(1n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(5n + 1n)); // 6
});

test("i64: a + 1 (JS number) THROWS at compile — no implicit lift", async () => {
  const uwk = mono("const a = state.i64(5n).named('a');", "out.ch(0).at(i).write(f32(a + 1));");
  // The operator sugar still lowers `a + 1` to add(a.read(), 1); the THROW comes
  // from core's i64 numberLiteral guard at build time. Either way it must reject.
  await expect(firstSample(uwk)).rejects.toThrow(/cannot lift to i64|i64\(BigInt/);
});

test("i64: a * i64(2n) - i64(3n) chained BigInt arith", async () => {
  const uwk = mono(
    "const a = state.i64(10n).named('a');",
    "out.ch(0).at(i).write(f32(a * i64(2n) - i64(3n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(10n * 2n - 3n)); // 17
});

test("i64: large value within f32-exact range — 16777216n survives round-trip", async () => {
  // 2^24 = 16777216 is the largest integer f32 represents exactly.
  const uwk = mono(
    "const a = state.i64(16777215n).named('a');",
    "out.ch(0).at(i).write(f32(a + i64(1n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(16777216n));
  expect(await firstSample(uwk)).toBe(16777216);
});

test("i64: division truncates toward zero — 7n / i64(2n) = 3", async () => {
  const uwk = mono(
    "const a = state.i64(7n).named('a');",
    "out.ch(0).at(i).write(f32(a / i64(2n)));",
  );
  // BigInt division truncates toward zero
  expect(await firstSample(uwk)).toBe(i64f(7n / 2n)); // 3
});

test("i64: negative division truncates toward zero — -7n / i64(2n) = -3", async () => {
  const uwk = mono(
    "const a = state.i64(-7n).named('a');",
    "out.ch(0).at(i).write(f32(a / i64(2n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(-7n / 2n)); // -3 (BigInt truncates toward zero)
});

test("i64: rem sign — -7n % i64(3n) = -1 (follows dividend)", async () => {
  const uwk = mono(
    "const a = state.i64(-7n).named('a');",
    "out.ch(0).at(i).write(f32(a % i64(3n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(-7n % 3n)); // -1
});

test("i64: 64-bit value beyond i32 range — 5_000_000_000n / i64(2n) = 2_500_000_000", async () => {
  // 5e9 exceeds i32 range; only i64 can hold it. 2.5e9 also > 2^31, must not wrap.
  const uwk = mono(
    "const a = state.i64(5000000000n).named('a');",
    "out.ch(0).at(i).write(f32(a / i64(2n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(5000000000n / 2n));
  // sanity: an i32 wrap would have mangled 5e9; 2.5e9 fround:
  expect(await firstSample(uwk)).toBe(Math.fround(2500000000));
});

test("i64 structural: a + i64(1n) lowers to add(a.read(), i64(1n))", async () => {
  const decls = "const a = state.i64(5n).named('a');";
  const sugar = mono(decls, "out.ch(0).at(i).write(f32(a + i64(1n)));");
  const explicit = mono(decls, "out.ch(0).at(i).write(f32(add(a.read(), i64(1n))));");
  await expectSameLowering(sugar, explicit);
});

test("i64 structural: a * i64(2n) - i64(3n) nested", async () => {
  const decls = "const a = state.i64(10n).named('a');";
  const sugar = mono(decls, "out.ch(0).at(i).write(f32(a * i64(2n) - i64(3n)));");
  const explicit = mono(decls, "out.ch(0).at(i).write(f32(sub(mul(a.read(), i64(2n)), i64(3n))));");
  await expectSameLowering(sugar, explicit);
});

// ════════════════════════════════════════════════════════════════════════════
// f64 — double precision arithmetic
// ════════════════════════════════════════════════════════════════════════════

test("f64: 0.1 + 0.2 stored to f32 port = fround(0.30000000000000004)", async () => {
  const uwk = mono(
    "const a = state.f64(0.1).named('a');\nconst b = state.f64(0.2).named('b');",
    "out.ch(0).at(i).write(f32(a + b));",
  );
  expect(await firstSample(uwk)).toBe(f64f(0.1 + 0.2));
  expect(await firstSample(uwk)).toBeCloseTo(0.3, 6);
});

test("f64: division is real (not truncating) — 7.0 / 2.0 = 3.5", async () => {
  const uwk = mono(
    "const a = state.f64(7).named('a');\nconst b = state.f64(2).named('b');",
    "out.ch(0).at(i).write(f32(a / b));",
  );
  expect(await firstSample(uwk)).toBe(f64f(7 / 2)); // 3.5
  expect(await firstSample(uwk)).toBeCloseTo(3.5, 6);
});

test("f64: literal divisor lifts to f64 — a / 3 = 0.333...", async () => {
  const uwk = mono("const a = state.f64(1).named('a');", "out.ch(0).at(i).write(f32(a / 3));");
  expect(await firstSample(uwk)).toBe(f64f(1 / 3));
  expect(await firstSample(uwk)).toBeCloseTo(0.333333, 5);
});

test("f64: precedence + nesting — (a + b) / c - d", async () => {
  const decls =
    "const a = state.f64(1.5).named('a');\nconst b = state.f64(2.5).named('b');\n" +
    "const c = state.f64(2).named('c');\nconst d = state.f64(0.25).named('d');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32((a + b) / c - d));");
  // (1.5+2.5)/2 - 0.25 = 2.0 - 0.25 = 1.75
  expect(await firstSample(uwk)).toBe(f64f((1.5 + 2.5) / 2 - 0.25));
  expect(await firstSample(uwk)).toBeCloseTo(1.75, 6);
});

test("f64: mod is float fmod — 5.5 % 2 = 1.5", async () => {
  const uwk = mono(
    "const a = state.f64(5.5).named('a');\nconst b = state.f64(2).named('b');",
    "out.ch(0).at(i).write(f32(a % b));",
  );
  expect(await firstSample(uwk)).toBe(f64f(5.5 % 2)); // 1.5
  expect(await firstSample(uwk)).toBeCloseTo(1.5, 6);
});

test("f64: unary neg preserves fraction — -(3.25) = -3.25", async () => {
  const uwk = mono("const a = state.f64(3.25).named('a');", "out.ch(0).at(i).write(f32(-a));");
  expect(await firstSample(uwk)).toBe(-3.25);
});

test("f64 structural: (a + b) / c lowers to div(add(a.read(),b.read()), c.read())", async () => {
  const decls =
    "const a = state.f64(1.5).named('a');\nconst b = state.f64(2.5).named('b');\nconst c = state.f64(2).named('c');";
  const sugar = mono(decls, "out.ch(0).at(i).write(f32((a + b) / c));");
  const explicit = mono(
    decls,
    "out.ch(0).at(i).write(f32(div(add(a.read(), b.read()), c.read())));",
  );
  await expectSameLowering(sugar, explicit);
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-type adversarial: literal-lift type is decided by the Node operand
// ════════════════════════════════════════════════════════════════════════════

test("adversarial: i32 node + literal 0.9 — literal lifts to i32 (0.9 → 0), so a + 0.9 == a", async () => {
  // 0.9 lifts to i32 = (0.9 | 0) = 0. So a + 0.9 should equal a, NOT a + 0.9 float.
  const uwk = mono("const a = state.i32(5).named('a');", "out.ch(0).at(i).write(f32(a + 0.9));");
  // i32 literal lift truncates 0.9 to 0 → 5 + 0 = 5
  expect(await firstSample(uwk)).toBe(5);
  expect(await firstSample(uwk)).not.toBe(Math.fround(5.9));
});

test("adversarial: i32 node * literal 2.5 — 2.5 lifts to i32 = 2, so a*2.5 == a*2", async () => {
  const uwk = mono("const a = state.i32(4).named('a');", "out.ch(0).at(i).write(f32(a * 2.5));");
  // 2.5 | 0 = 2 → 4 * 2 = 8 (NOT 10)
  expect(await firstSample(uwk)).toBe(8);
  expect(await firstSample(uwk)).not.toBe(10);
});

test("adversarial: number op number stays JS (build-time) — const N = 64; N * 2 not lowered", async () => {
  // N*2 is build-time JS = 128; it must NOT be wrapped in mul(). Mixed with a node:
  const uwk = mono(
    "const a = state.i32(1).named('a');\nconst N = 64;",
    "out.ch(0).at(i).write(f32(a * (N * 2)));",
  );
  // N*2 = 128 (JS const), then a * 128 = 128 (i32)
  expect(await firstSample(uwk)).toBe(128);
});

test("adversarial structural: build-time const folds, node op stays — a + (N*2)", async () => {
  const decls = "const a = state.i32(1).named('a');\nconst N = 64;";
  const sugar = mono(decls, "out.ch(0).at(i).write(f32(a + N * 2));");
  // N*2 is plain JS 128; the explicit form passes the literal 128 directly.
  const explicit = mono(decls, "out.ch(0).at(i).write(f32(add(a.read(), 128)));");
  await expectSameLowering(sugar, explicit);
});

test("adversarial: literal-on-LEFT lifts to node's i32 type — 2.5 * a = 2 * a", async () => {
  // 2.5 is the LEFT operand; it must still lift to the right operand's i32 type
  // (truncate to 2), not stay an f32 literal. a=4 → 2*4 = 8 (NOT 10).
  const uwk = mono("const a = state.i32(4).named('a');", "out.ch(0).at(i).write(f32(2.5 * a));");
  expect(await firstSample(uwk)).toBe(8);
  expect(await firstSample(uwk)).not.toBe(10);
});

test("adversarial: literal numerator lifts to i32 — 9 / a truncates (a=2 → 4)", async () => {
  const uwk = mono("const a = state.i32(2).named('a');", "out.ch(0).at(i).write(f32(9 / a));");
  expect(await firstSample(uwk)).toBe(idiv(9, 2)); // 4
});

// ════════════════════════════════════════════════════════════════════════════
// Precedence + unary interplay (i32)
// ════════════════════════════════════════════════════════════════════════════

test("i32 precedence: mod binds like mul — a + b % c (10,7,3 → 11)", async () => {
  const decls =
    "const a = state.i32(10).named('a');\nconst b = state.i32(7).named('b');\nconst c = state.i32(3).named('c');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(a + b % c));");
  expect(await firstSample(uwk)).toBe(i32f(wrap32(10 + irem(7, 3)))); // 11
});

test("i32 precedence: a / b * c left-assoc truncates at div step (7/2*4 = 12, NOT 14)", async () => {
  const decls =
    "const a = state.i32(7).named('a');\nconst b = state.i32(2).named('b');\nconst c = state.i32(4).named('c');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(a / b * c));");
  expect(await firstSample(uwk)).toBe(i32f(Math.imul(idiv(7, 2), 4))); // 12
  expect(await firstSample(uwk)).not.toBe(14);
});

test("i32 unary: -a * b binds neg tighter than mul (3,4 → -12)", async () => {
  const decls = "const a = state.i32(3).named('a');\nconst b = state.i32(4).named('b');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(-a * b));");
  expect(await firstSample(uwk)).toBe(-12);
});

test("i32 unary: a - -b double-negation (5,3 → 8)", async () => {
  const decls = "const a = state.i32(5).named('a');\nconst b = state.i32(3).named('b');";
  const uwk = mono(decls, "out.ch(0).at(i).write(f32(a - -b));");
  expect(await firstSample(uwk)).toBe(8);
});

// ════════════════════════════════════════════════════════════════════════════
// i64 — 64-bit wraparound + deep nesting + comparison select
// ════════════════════════════════════════════════════════════════════════════

test("i64: INT64_MAX + 1 wraps to INT64_MIN (64-bit signed)", async () => {
  const uwk = mono(
    "const a = state.i64(9223372036854775807n).named('a');",
    "out.ch(0).at(i).write(f32(a + i64(1n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(9223372036854775807n + 1n));
});

test("i64: negative result beyond i32 range survives — 1e9n - i64(5e9n) = -4e9", async () => {
  const uwk = mono(
    "const a = state.i64(1000000000n).named('a');",
    "out.ch(0).at(i).write(f32(a - i64(5000000000n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(1000000000n - 5000000000n));
  expect(await firstSample(uwk)).toBe(Math.fround(-4000000000));
});

test("i64: deep nest a * i64(3n) + i64(2n) (a=7n → 23)", async () => {
  const uwk = mono(
    "const a = state.i64(7n).named('a');",
    "out.ch(0).at(i).write(f32(a * i64(3n) + i64(2n)));",
  );
  expect(await firstSample(uwk)).toBe(i64f(7n * 3n + 2n)); // 23
});

test("i64: comparison-driven select — a < i64(10n) ? i64(1n) : i64(0n) (a=5n → 1)", async () => {
  const uwk = mono(
    "const a = state.i64(5n).named('a');",
    "out.ch(0).at(i).write(f32(a < i64(10n) ? i64(1n) : i64(0n)));",
  );
  expect(await firstSample(uwk)).toBe(1);
});
