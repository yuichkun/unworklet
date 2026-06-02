/**
 * EXHAUSTIVE bare-state lowering tests. Category: a bare `State<T>` reference used
 * in a `Node<T>` position auto-reads (`g` → `g.read()`), while a write target /
 * declaration / `State`-typed handle position keeps its reference. This file
 * hammers every primitive type (f32 / f64 / i32 / i64 / bool), every value
 * position (sole write value, math-fn arg, constructor arg, select cond / value,
 * nested call args, operator operand), and the adversarial edges that try to make
 * the read-wrap fire in the wrong place (or not fire at all).
 *
 * Two oracles:
 *  - `expectSameLowering(sugar, explicit)` proves the sugar lowers to the SAME
 *    compiled processor as a hand-written chain-DSL form that already spells the
 *    `.read()` (structural ground truth — NO operator / index / bare-state / if
 *    sugar in the explicit side).
 *  - `renderLowered` runs the lowered processor through REAL WebAssembly and
 *    checks the per-sample output against a pure-JS / BigInt reference (semantic
 *    ground truth — int truncation / wraparound / accumulation is unambiguous).
 *
 * The single audio output port is `f32`, so every value observed through the
 * output is `Math.fround(...)` of the computed math.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const N = 128;

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

/** Render one block, return channel-0 output as a plain number[]. */
async function render1(uwk: string): Promise<number[]> {
  const r = await renderLowered(uwk, { sampleRate: SR, duration: N / SR });
  return Array.from(r.outputs.main![0]!);
}

/** Render and return the very first output sample. */
async function first(uwk: string): Promise<number> {
  return (await render1(uwk))[0]!;
}

// ── reference helpers ────────────────────────────────────────────────────────
const fr = (n: number): number => Math.fround(n);
const wrap32 = (n: number): number => n | 0;
const i32f = (n: number): number => fr(wrap32(n));
const wrap64 = (n: bigint): bigint => BigInt.asIntN(64, n);
const i64f = (n: bigint): number => fr(Number(wrap64(n)));

// ════════════════════════════════════════════════════════════════════════════
// SOLE-VALUE read: a bare state as the only write value → s.read()
// ════════════════════════════════════════════════════════════════════════════

test("f32: bare state as sole write value reads (g → g.read())", async () => {
  const decls = "const g = state.f32(0.5).named('g');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(g);"),
    mono(decls, "out.ch(0).at(i).write(g.read());"),
  );
});

test("f32: bare state sole value — behavioral, default 0.5 flows out", async () => {
  const got = await render1(
    mono("const g = state.f32(0.5).named('g');", "out.ch(0).at(i).write(g);"),
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBe(fr(0.5));
});

test("f64: bare f64 state read stored to f32 port (default 0.1 → fround)", async () => {
  const decls = "const g = state.f64(0.1).named('g');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(g));"),
    mono(decls, "out.ch(0).at(i).write(f32(g.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(g));"))).toBe(fr(0.1));
});

test("i32: bare i32 state through f32() reads (m → f32(m.read()))", async () => {
  const decls = "const m = state.i32(7).named('m');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(m));"),
    mono(decls, "out.ch(0).at(i).write(f32(m.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(m));"))).toBe(i32f(7));
});

test("i64: bare i64 state through f32() reads (m → f32(m.read()))", async () => {
  const decls = "const m = state.i64(7n).named('m');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(m));"),
    mono(decls, "out.ch(0).at(i).write(f32(m.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(m));"))).toBe(i64f(7n));
});

test("bool: bare bool state in user-written select cond reads (c → c.read())", async () => {
  const decls = "const c = state.bool(true).named('c');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(select(c, f32(1), f32(0)));"),
    mono(decls, "out.ch(0).at(i).write(select(c.read(), f32(1), f32(0)));"),
  );
});

test("bool: bare bool state select cond behavioral — true → 1, false → 0", async () => {
  const t = await first(
    mono(
      "const c = state.bool(true).named('c');",
      "out.ch(0).at(i).write(select(c, f32(1), f32(0)));",
    ),
  );
  const f = await first(
    mono(
      "const c = state.bool(false).named('c');",
      "out.ch(0).at(i).write(select(c, f32(1), f32(0)));",
    ),
  );
  expect(t).toBe(1);
  expect(f).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// MATH-FN args: a bare state as a math function argument → s.read()
// ════════════════════════════════════════════════════════════════════════════

test("f32: bare state in abs() reads (abs(g) → abs(g.read()))", async () => {
  const decls = "const g = state.f32(-0.5).named('g');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(abs(g));"),
    mono(decls, "out.ch(0).at(i).write(abs(g.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(abs(g));"))).toBe(fr(0.5));
});

test("f32: bare states in min/max read both args", async () => {
  const decls = "const a = state.f32(0.3).named('a');\nconst b = state.f32(0.7).named('b');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(max(a, b));"),
    mono(decls, "out.ch(0).at(i).write(max(a.read(), b.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(max(a, b));"))).toBe(fr(0.7));
  expect(await first(mono(decls, "out.ch(0).at(i).write(min(a, b));"))).toBe(fr(0.3));
});

test("f32: bare states in clamp() read all three args", async () => {
  const decls =
    "const g = state.f32(2).named('g');\nconst lo = state.f32(0).named('lo');\nconst hi = state.f32(1).named('hi');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(clamp(g, lo, hi));"),
    mono(decls, "out.ch(0).at(i).write(clamp(g.read(), lo.read(), hi.read()));"),
  );
  // 2 clamped to [0,1] → 1
  expect(await first(mono(decls, "out.ch(0).at(i).write(clamp(g, lo, hi));"))).toBe(1);
});

test("f32: bare state in transcendental sin() reads", async () => {
  const decls = "const ph = state.f32(0).named('ph');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(sin(ph));"),
    mono(decls, "out.ch(0).at(i).write(sin(ph.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(sin(ph));"))).toBe(fr(Math.sin(0)));
});

test("f32: nested math fns — sqrt(abs(g)) reads the innermost state once", async () => {
  const decls = "const g = state.f32(-4).named('g');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(sqrt(abs(g)));"),
    mono(decls, "out.ch(0).at(i).write(sqrt(abs(g.read())));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(sqrt(abs(g)));"))).toBe(fr(Math.sqrt(4)));
});

// ════════════════════════════════════════════════════════════════════════════
// OPERATOR operands: bare state on either / both sides reads (operator pass owns it)
// ════════════════════════════════════════════════════════════════════════════

test("f32: bare state + literal — a + 0.25 reads a (add(a.read(), 0.25))", async () => {
  const decls = "const a = state.f32(0.5).named('a');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(a + 0.25);"),
    mono(decls, "out.ch(0).at(i).write(add(a.read(), 0.25));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(a + 0.25);"))).toBe(fr(0.75));
});

test("f32: literal + bare state on LEFT — 0.25 + a reads a", async () => {
  const decls = "const a = state.f32(0.5).named('a');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(0.25 + a);"),
    mono(decls, "out.ch(0).at(i).write(add(0.25, a.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(0.25 + a);"))).toBe(fr(0.75));
});

test("f32: bare state on BOTH sides — a * b reads both", async () => {
  const decls = "const a = state.f32(0.5).named('a');\nconst b = state.f32(0.6).named('b');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(a * b);"),
    mono(decls, "out.ch(0).at(i).write(mul(a.read(), b.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(a * b);"))).toBe(fr(0.3));
});

test("f32: same bare state used twice — a + a reads a on both operands", async () => {
  const decls = "const a = state.f32(0.4).named('a');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(a + a);"),
    mono(decls, "out.ch(0).at(i).write(add(a.read(), a.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(a + a);"))).toBe(fr(0.8));
});

test("f32: unary neg on bare state — -a reads then negates (neg(a.read()))", async () => {
  const decls = "const a = state.f32(0.5).named('a');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(-a);"),
    mono(decls, "out.ch(0).at(i).write(neg(a.read()));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(-a);"))).toBe(fr(-0.5));
});

test("bool: not on a bare bool state — !c reads then negates (not(c.read()))", async () => {
  const decls = "const c = state.bool(false).named('c');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(select(!c, f32(1), f32(0)));"),
    mono(decls, "out.ch(0).at(i).write(select(not(c.read()), f32(1), f32(0)));"),
  );
  // c false → !c true → 1
  expect(await first(mono(decls, "out.ch(0).at(i).write(select(!c, f32(1), f32(0)));"))).toBe(1);
});

test("bool: comparison producing a bool from a bare state — a > b reads both", async () => {
  const decls = "const a = state.f32(0.7).named('a');\nconst b = state.f32(0.3).named('b');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(select(a > b, f32(1), f32(0)));"),
    mono(decls, "out.ch(0).at(i).write(select(gt(a.read(), b.read()), f32(1), f32(0)));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(select(a > b, f32(1), f32(0)));"))).toBe(1);
});

// ════════════════════════════════════════════════════════════════════════════
// PRECEDENCE + NESTING DEPTH on bare states (associativity / grouping must match)
// ════════════════════════════════════════════════════════════════════════════

test("f32: precedence — a + b * c reads each once, mul binds tighter", async () => {
  const decls =
    "const a = state.f32(0.1).named('a');\nconst b = state.f32(0.2).named('b');\nconst c = state.f32(0.5).named('c');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(a + b * c);"),
    mono(decls, "out.ch(0).at(i).write(add(a.read(), mul(b.read(), c.read())));"),
  );
  // f32 states fr(0.1),fr(0.2),fr(0.5); each op rounds in f32 width.
  expect(await first(mono(decls, "out.ch(0).at(i).write(a + b * c);"))).toBe(
    fr(fr(0.1) + fr(fr(0.2) * fr(0.5))),
  );
});

test("f32: parens override precedence — (a + b) * c reads each once", async () => {
  const decls =
    "const a = state.f32(0.1).named('a');\nconst b = state.f32(0.2).named('b');\nconst c = state.f32(0.5).named('c');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write((a + b) * c);"),
    mono(decls, "out.ch(0).at(i).write(mul(add(a.read(), b.read()), c.read()));"),
  );
  // f32 states fr(0.1),fr(0.2),fr(0.5); each op rounds in f32 width.
  expect(await first(mono(decls, "out.ch(0).at(i).write((a + b) * c);"))).toBe(
    fr(fr(fr(0.1) + fr(0.2)) * fr(0.5)),
  );
});

test("f32: left-assoc subtraction on bare states — a - b - c == (a-b)-c", async () => {
  const decls =
    "const a = state.f32(0.9).named('a');\nconst b = state.f32(0.3).named('b');\nconst c = state.f32(0.2).named('c');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(a - b - c);"),
    mono(decls, "out.ch(0).at(i).write(sub(sub(a.read(), b.read()), c.read()));"),
  );
  // f32 states hold fr(0.9), fr(0.3), fr(0.2); each sub rounds in f32 width.
  expect(await first(mono(decls, "out.ch(0).at(i).write(a - b - c);"))).toBe(
    fr(fr(fr(0.9) - fr(0.3)) - fr(0.2)),
  );
});

test("f32: deep nesting — abs(a) + max(b, c) reads each state once", async () => {
  const decls =
    "const a = state.f32(-0.4).named('a');\nconst b = state.f32(0.2).named('b');\nconst c = state.f32(0.6).named('c');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(abs(a) + max(b, c));"),
    mono(decls, "out.ch(0).at(i).write(add(abs(a.read()), max(b.read(), c.read())));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(abs(a) + max(b, c));"))).toBe(
    fr(fr(0.4) + fr(0.6)),
  );
});

test("f32: ternary with bare-state cond + bare-state branches reads all three", async () => {
  const decls =
    "const c = state.f32(1).named('c');\nconst x = state.f32(0.8).named('x');\nconst y = state.f32(0.2).named('y');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(c > f32(0) ? x : y);"),
    mono(decls, "out.ch(0).at(i).write(select(gt(c.read(), f32(0)), x.read(), y.read()));"),
  );
  // c=1 > 0 → x = 0.8
  expect(await first(mono(decls, "out.ch(0).at(i).write(c > f32(0) ? x : y);"))).toBe(fr(0.8));
});

// ════════════════════════════════════════════════════════════════════════════
// WRITE TARGET / HANDLE positions: a bare state must NOT read-wrap
// ════════════════════════════════════════════════════════════════════════════

test("write target stays a handle — s.write(otherState) reads the value, not the target", async () => {
  const decls = "const a = state.f32(3).named('a');\nconst b = state.f32(9).named('b');";
  await expectSameLowering(
    mono(decls, "a.write(b);\nout.ch(0).at(i).write(a);"),
    mono(decls, "a.write(b.read());\nout.ch(0).at(i).write(a.read());"),
  );
  expect(await first(mono(decls, "a.write(b);\nout.ch(0).at(i).write(a);"))).toBe(fr(9));
});

test("self-update through operator — s.write(s + literal) reads only the value side", async () => {
  const decls = "const c = state.i32(0).named('c');";
  await expectSameLowering(
    mono(decls, "c.write(c + i32(1));\nout.ch(0).at(i).write(f32(c));"),
    mono(decls, "c.write(add(c.read(), i32(1)));\nout.ch(0).at(i).write(f32(c.read()));"),
  );
});

test("counter behavioral — c.write(c + i32(1)) increments per sample (1,2,3,…)", async () => {
  const got = await render1(
    mono(
      "const c = state.i32(0).named('c');",
      "c.write(c + i32(1));\nout.ch(0).at(i).write(f32(c));",
    ),
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBe(i32f(n + 1));
});

// ════════════════════════════════════════════════════════════════════════════
// i64 bare-state arithmetic (NO implicit number lift — BigInt literals only)
// ════════════════════════════════════════════════════════════════════════════

test("i64: bare state + i64(literal) reads (add(m.read(), i64(2n)))", async () => {
  const decls = "const m = state.i64(5n).named('m');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(m + i64(2n)));"),
    mono(decls, "out.ch(0).at(i).write(f32(add(m.read(), i64(2n))));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(m + i64(2n)));"))).toBe(i64f(7n));
});

test("i64: bare state on both sides — m * n reads both (BigInt mul)", async () => {
  const decls = "const m = state.i64(6n).named('m');\nconst n = state.i64(7n).named('n');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(m * n));"),
    mono(decls, "out.ch(0).at(i).write(f32(mul(m.read(), n.read())));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(m * n));"))).toBe(i64f(42n));
});

test("i64: bare-state counter accumulates by 2n per sample (2,4,6,…)", async () => {
  const got = await render1(
    mono(
      "const m = state.i64(0n).named('m');",
      "m.write(m + i64(2n));\nout.ch(0).at(i).write(f32(m));",
    ),
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBe(i64f(BigInt(2 * (n + 1))));
});

test("i64: 64-bit value beyond i32 range survives — m / i64(2n) on bare state", async () => {
  const decls = "const m = state.i64(5000000000n).named('m');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(m / i64(2n)));"),
    mono(decls, "out.ch(0).at(i).write(f32(div(m.read(), i64(2n))));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(m / i64(2n)));"))).toBe(
    i64f(5000000000n / 2n),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// i32 bare-state arithmetic (truncating div, rem sign, literal-lift truncation)
// ════════════════════════════════════════════════════════════════════════════

test("i32: bare state truncating division — a / b reads both (7/2 = 3)", async () => {
  const decls = "const a = state.i32(7).named('a');\nconst b = state.i32(2).named('b');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(a / b));"),
    mono(decls, "out.ch(0).at(i).write(f32(div(a.read(), b.read())));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(a / b));"))).toBe(3);
});

test("i32: bare state rem_s follows dividend sign — a % b (-7 % 3 = -1)", async () => {
  const decls = "const a = state.i32(-7).named('a');\nconst b = state.i32(3).named('b');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(a % b));"),
    mono(decls, "out.ch(0).at(i).write(f32(mod(a.read(), b.read())));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(a % b));"))).toBe((-7 % 3) | 0);
});

test("i32: literal lifts to the bare-state's i32 type — a * 2.5 truncates to a*2", async () => {
  // 2.5 lifts to i32 = 2 (NOT float 2.5). a=4 → 8, NOT 10.
  const decls = "const a = state.i32(4).named('a');";
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(a * 2.5));"))).toBe(8);
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(a * 2.5));"))).not.toBe(10);
});

test("i32: bare-state 32-bit wraparound — large value wraps (structural)", async () => {
  const decls = "const a = state.i32(2147483647).named('a');\nconst b = state.i32(1).named('b');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(a + b));"),
    mono(decls, "out.ch(0).at(i).write(f32(add(a.read(), b.read())));"),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// f64 bare-state arithmetic (real division, double precision)
// ════════════════════════════════════════════════════════════════════════════

test("f64: bare-state real division — a / b is NOT truncating (7.0/2.0 = 3.5)", async () => {
  const decls = "const a = state.f64(7).named('a');\nconst b = state.f64(2).named('b');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(a / b));"),
    mono(decls, "out.ch(0).at(i).write(f32(div(a.read(), b.read())));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(a / b));"))).toBe(fr(3.5));
});

test("f64: bare-state precedence + nesting — (a + b) / c - d reads each once", async () => {
  const decls =
    "const a = state.f64(1.5).named('a');\nconst b = state.f64(2.5).named('b');\n" +
    "const c = state.f64(2).named('c');\nconst d = state.f64(0.25).named('d');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32((a + b) / c - d));"),
    mono(
      decls,
      "out.ch(0).at(i).write(f32(sub(div(add(a.read(), b.read()), c.read()), d.read())));",
    ),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32((a + b) / c - d));"))).toBe(
    fr((1.5 + 2.5) / 2 - 0.25),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// MIXING: bare state alongside channel reads / params / select value positions
// ════════════════════════════════════════════════════════════════════════════

test("mix: bare state * channel sample — gain * input reads gain, keeps channel .at(i)", async () => {
  const decls = "const gain = state.f32(0.5).named('gain');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(gain * input.ch(0).at(i));"),
    mono(decls, "out.ch(0).at(i).write(mul(gain.read(), input.ch(0).at(i)));"),
  );
  const r = await renderLowered(mono(decls, "out.ch(0).at(i).write(gain * input.ch(0).at(i));"), {
    sampleRate: SR,
    duration: N / SR,
    inputs: { main: [new Float32Array(N).fill(0.4)] },
  });
  for (let n = 0; n < N; n++) expect(r.outputs.main![0]![n]).toBe(fr(fr(0.5) * fr(0.4)));
});

test("mix: bare state in select VALUE position (not cond) reads — select(cond, g, 0)", async () => {
  const decls = "const g = state.f32(0.6).named('g');\nconst t = state.f32(1).named('t');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(select(t > f32(0), g, f32(0)));"),
    mono(decls, "out.ch(0).at(i).write(select(gt(t.read(), f32(0)), g.read(), f32(0)));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(select(t > f32(0), g, f32(0)));"))).toBe(
    fr(0.6),
  );
});

test("mix: two bare states in both branch positions — select(cond, x, y)", async () => {
  const decls =
    "const x = state.f32(0.9).named('x');\nconst y = state.f32(0.1).named('y');\nconst t = state.f32(0).named('t');";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(select(t < f32(1), x, y));"),
    mono(decls, "out.ch(0).at(i).write(select(lt(t.read(), f32(1)), x.read(), y.read()));"),
  );
  // t=0 < 1 → x = 0.9
  expect(await first(mono(decls, "out.ch(0).at(i).write(select(t < f32(1), x, y));"))).toBe(
    fr(0.9),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL: build-time number constants must NOT be touched by bare-state logic
// ════════════════════════════════════════════════════════════════════════════

test("adversarial: const N (plain number) is build-time JS — a * N stays a single mul", async () => {
  const decls = "const a = state.f32(0.5).named('a');\nconst K = 4;";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(a * K);"),
    mono(decls, "out.ch(0).at(i).write(mul(a.read(), 4));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(a * K);"))).toBe(fr(0.5 * 4));
});

test("adversarial: number op number folds, bare state stays read — a + (K * 2)", async () => {
  const decls = "const a = state.i32(1).named('a');\nconst K = 64;";
  await expectSameLowering(
    mono(decls, "out.ch(0).at(i).write(f32(a + K * 2));"),
    mono(decls, "out.ch(0).at(i).write(f32(add(a.read(), 128)));"),
  );
  expect(await first(mono(decls, "out.ch(0).at(i).write(f32(a + K * 2));"))).toBe(i32f(1 + 128));
});
