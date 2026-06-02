/**
 * Exhaustive bit-identity + behavioral tests for the unary / ternary / not sugar
 * lowering. The category covers:
 *
 *   -x        → neg(x)            (prefix minus, type-directed)
 *   !b        → not(b)            (logical, bool-only in core)
 *   a != b    → not(eq(a, b))     (negated equality)
 *   c ? x : y → select(c, x, y)   (with bare-State branch auto-read)
 *
 * `expectSameLowering` proves structural identity against a hand-written explicit
 * chain-DSL form (the ground truth). `renderLowered` proves SEMANTICS against a
 * pure-JS reference — the most robust check, since the JS math is unambiguous.
 *
 * Type-directed dispatch rule under test: an operator lowers ONLY if an operand
 * is / becomes a Node or State. `number op number` (build-time consts) stays JS.
 * A ternary lowers only when its CONDITION is a DSP expr; a JS-boolean condition
 * leaves the whole `?:` as a build-time expression.
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

/** A deterministic bipolar ramp input in [-1, ~1). */
function ramp(): Float32Array {
  const x = new Float32Array(N);
  for (let n = 0; n < N; n++) x[n] = (n / N) * 2 - 1;
  return x;
}

/** Render a mono body against a single ramp input channel. */
async function renderRamp(
  body: string,
  decls = "",
  x: Float32Array = ramp(),
): Promise<Float32Array> {
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: N / SR,
    inputs: { main: [x] },
  });
  return r.outputs.main![0]!;
}

/** Round to f32 precision so the JS reference matches WASM f32 storage. */
const f32 = (v: number): number => Math.fround(v);

// ───────────────────────────────────────────────────────────────────────────
// neg (-x)
// ───────────────────────────────────────────────────────────────────────────

test("neg: -input lowers to neg(input) and behaves as negation", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(-input.ch(0).at(i));`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(-x[n]!), 6);
});

test("neg: structural — -input == neg(input)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(-input.ch(0).at(i));`),
    mono("", `out.ch(0).at(i).write(neg(input.ch(0).at(i)));`),
  );
});

test("neg: -(a + b) negates the whole sum, not just a", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(-(input.ch(0).at(i) + 0.5));`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(-f32(x[n]! + 0.5)), 5);
});

test("neg: structural — -(a + b) == neg(add(a, b))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(-(input.ch(0).at(i) + 0.5));`),
    mono("", `out.ch(0).at(i).write(neg(add(input.ch(0).at(i), 0.5)));`),
  );
});

test("neg: double negation - -x == x (precedence + identity)", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(- -input.ch(0).at(i));`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]!), 6);
});

test("neg: structural — - -input == neg(neg(input))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(- -input.ch(0).at(i));`),
    mono("", `out.ch(0).at(i).write(neg(neg(input.ch(0).at(i))));`),
  );
});

test("neg: precedence — -a * 2 negates a FIRST then multiplies ((-a)*2)", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(-input.ch(0).at(i) * 2);`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(f32(-x[n]!) * 2), 5);
});

test("neg: structural — -a * 2 == mul(neg(a), 2)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(-input.ch(0).at(i) * 2);`),
    mono("", `out.ch(0).at(i).write(mul(neg(input.ch(0).at(i)), 2));`),
  );
});

test("neg: a * -b — the unary minus applies to the literal operand", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(input.ch(0).at(i) * -0.5);`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]! * -0.5), 5);
});

test("neg: a - -b is subtraction of a negated literal (binary vs unary minus)", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(input.ch(0).at(i) - -0.5);`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]! - -0.5), 5);
});

test("neg: structural — a - -b == sub(a, -0.5) (literal stays JS)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) - -0.5);`),
    mono("", `out.ch(0).at(i).write(sub(input.ch(0).at(i), -0.5));`),
  );
});

test("neg: unary minus vs binary minus in -a - a", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(-input.ch(0).at(i) - input.ch(0).at(i));`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(f32(-x[n]!) - x[n]!), 5);
});

test("neg: bare-State operand reads then negates (-s == neg(s.read()))", async () => {
  await expectSameLowering(
    mono("const s = state.f32(0).named('s');", `out.ch(0).at(i).write(-s);`),
    mono("const s = state.f32(0).named('s');", `out.ch(0).at(i).write(neg(s.read()));`),
  );
});

test("neg: on an i32 state stays integer negation (-n == neg(n.read()))", async () => {
  await expectSameLowering(
    mono("const n = state.i32(3).named('n');", `n.write(-n);`),
    mono("const n = state.i32(3).named('n');", `n.write(neg(n.read()));`),
  );
});

test("neg: build-time number negation stays JS (input * -K, K a const)", async () => {
  const x = ramp();
  // K = 3 is a build-time const; -K folds in JS to -3.
  const got = await renderRamp(`out.ch(0).at(i).write(input.ch(0).at(i) * -K);`, "const K = 3;");
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]! * -3), 5);
});

test("neg: structural — input * -K == mul(input, -K) (no neg call emitted)", async () => {
  await expectSameLowering(
    mono("const K = 3;", `out.ch(0).at(i).write(input.ch(0).at(i) * -K);`),
    mono("const K = 3;", `out.ch(0).at(i).write(mul(input.ch(0).at(i), -K));`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// not (!b)
// ───────────────────────────────────────────────────────────────────────────

test("not: !(a > 0) flips the comparison result", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(select(!(input.ch(0).at(i) > 0), f32(1), f32(0)));`,
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? 0 : 1, 6);
});

test("not: structural — !(a > 0) == not(gt(a, 0))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(!(input.ch(0).at(i) > 0), f32(1), f32(0)));`),
    mono("", `out.ch(0).at(i).write(select(not(gt(input.ch(0).at(i), 0)), f32(1), f32(0)));`),
  );
});

test("not: double negation !!(a > 0) round-trips to the comparison", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(select(!!(input.ch(0).at(i) > 0), f32(1), f32(0)));`,
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? 1 : 0, 6);
});

test("not: structural — !!(a > 0) == not(not(gt(a, 0)))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(!!(input.ch(0).at(i) > 0), f32(1), f32(0)));`),
    mono("", `out.ch(0).at(i).write(select(not(not(gt(input.ch(0).at(i), 0))), f32(1), f32(0)));`),
  );
});

test("not: on a bare bool state reads then negates (!c == not(c.read()))", async () => {
  await expectSameLowering(
    mono(
      "const c = state.bool(false).named('c');",
      `out.ch(0).at(i).write(select(!c, f32(1), f32(0)));`,
    ),
    mono(
      "const c = state.bool(false).named('c');",
      `out.ch(0).at(i).write(select(not(c.read()), f32(1), f32(0)));`,
    ),
  );
});

test("not: behavior on a bool state — !c is 1 when c is false (default)", async () => {
  const got = await renderRamp(
    `out.ch(0).at(i).write(select(!c, f32(1), f32(0)));`,
    "const c = state.bool(false).named('c');",
  );
  // c never set true → !c is always true → output 1.
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(1, 6);
});

test("not: !!c on a bool state == not(not(c.read()))", async () => {
  await expectSameLowering(
    mono(
      "const c = state.bool(false).named('c');",
      `out.ch(0).at(i).write(select(!!c, f32(1), f32(0)));`,
    ),
    mono(
      "const c = state.bool(false).named('c');",
      `out.ch(0).at(i).write(select(not(not(c.read())), f32(1), f32(0)));`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// a != b  →  not(eq(a, b))
// ───────────────────────────────────────────────────────────────────────────

test("not-eq: a != b lowers to not(eq(a, b)) — true when unequal", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(select(input.ch(0).at(i) != 0.5, f32(1), f32(0)));`,
  );
  // ramp lands exactly on 0.5? n where (n/128)*2-1 == 0.5 → n = 96. f32-store both.
  for (let n = 0; n < N; n++) {
    const equal = f32(x[n]!) === f32(0.5);
    expect(got[n]).toBeCloseTo(equal ? 0 : 1, 6);
  }
});

test("not-eq: structural — a != b == not(eq(a, b))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) != 0.5, f32(1), f32(0)));`),
    mono("", `out.ch(0).at(i).write(select(not(eq(input.ch(0).at(i), 0.5)), f32(1), f32(0)));`),
  );
});

test("not-eq: !== triple-bang also lowers to not(eq(...))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) !== 0.5, f32(1), f32(0)));`),
    mono("", `out.ch(0).at(i).write(select(not(eq(input.ch(0).at(i), 0.5)), f32(1), f32(0)));`),
  );
});

test("not-eq: !(a != b) double-negates back to eq — true when equal", async () => {
  // !(a != b) == not(not(eq(a, b))). At an exact match outputs 1, else 0.
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(select(!(input.ch(0).at(i) != 0), f32(1), f32(0)));`,
  );
  for (let n = 0; n < N; n++) {
    const equal = f32(x[n]!) === 0;
    expect(got[n]).toBeCloseTo(equal ? 1 : 0, 6);
  }
});

test("not-eq: structural — !(a != b) == not(not(eq(a, b)))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(!(input.ch(0).at(i) != 0), f32(1), f32(0)));`),
    mono("", `out.ch(0).at(i).write(select(not(not(eq(input.ch(0).at(i), 0))), f32(1), f32(0)));`),
  );
});

test("not-eq: a != b on a bare state reads the state (s != 0 == not(eq(s.read(), 0)))", async () => {
  await expectSameLowering(
    mono(
      "const s = state.f32(0).named('s');",
      `out.ch(0).at(i).write(select(s != 0, f32(1), f32(0)));`,
    ),
    mono(
      "const s = state.f32(0).named('s');",
      `out.ch(0).at(i).write(select(not(eq(s.read(), 0)), f32(1), f32(0)));`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// ternary (c ? x : y)
// ───────────────────────────────────────────────────────────────────────────

test("ternary: c ? f32(1) : f32(0) selects on the Node condition", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? f32(1) : f32(0));`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? 1 : 0, 6);
});

test("ternary: structural — c ? x : y == select(c, x, y)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? f32(1) : f32(0));`),
    mono("", `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0), f32(1), f32(0)));`),
  );
});

test("ternary: nested in the false branch — a ? b : (c ? d : e)", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? f32(1) : input.ch(0).at(i) < -0.5 ? f32(-1) : f32(0));`,
  );
  for (let n = 0; n < N; n++) {
    const expected = x[n]! > 0 ? 1 : x[n]! < -0.5 ? -1 : 0;
    expect(got[n]).toBeCloseTo(expected, 6);
  }
});

test("ternary: structural — nested false branch", async () => {
  await expectSameLowering(
    mono(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? f32(1) : input.ch(0).at(i) < -0.5 ? f32(-1) : f32(0));`,
    ),
    mono(
      "",
      `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0), f32(1), select(lt(input.ch(0).at(i), -0.5), f32(-1), f32(0))));`,
    ),
  );
});

test("ternary: nested in the TRUE branch — a ? (b ? c : d) : e", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? (input.ch(0).at(i) > 0.5 ? f32(2) : f32(1)) : f32(0));`,
  );
  for (let n = 0; n < N; n++) {
    const expected = x[n]! > 0 ? (x[n]! > 0.5 ? 2 : 1) : 0;
    expect(got[n]).toBeCloseTo(expected, 6);
  }
});

test("ternary: BOTH branches are bare states — both auto-read (c ? s1 : s2)", async () => {
  await expectSameLowering(
    mono(
      "const a = state.f32(2).named('a');\nconst b = state.f32(3).named('b');",
      `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? a : b);`,
    ),
    mono(
      "const a = state.f32(2).named('a');\nconst b = state.f32(3).named('b');",
      `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0), a.read(), b.read()));`,
    ),
  );
});

test("ternary: behavior — c ? s1 : s2 picks each state's value (both read)", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? a : b);`,
    "const a = state.f32(2).named('a');\nconst b = state.f32(3).named('b');",
  );
  // a defaults 2, b defaults 3; neither is written.
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? 2 : 3, 6);
});

test("ternary: ONLY the true branch is a bare state, false is a Node", async () => {
  await expectSameLowering(
    mono(
      "const a = state.f32(2).named('a');",
      `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? a : input.ch(0).at(i));`,
    ),
    mono(
      "const a = state.f32(2).named('a');",
      `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0), a.read(), input.ch(0).at(i)));`,
    ),
  );
});

test("ternary: a bare-State CONDITION (bool) auto-reads (c ? x : y)", async () => {
  await expectSameLowering(
    mono("const c = state.bool(false).named('c');", `out.ch(0).at(i).write(c ? f32(1) : f32(0));`),
    mono(
      "const c = state.bool(false).named('c');",
      `out.ch(0).at(i).write(select(c.read(), f32(1), f32(0)));`,
    ),
  );
});

test("ternary: a not-condition — !(a > 0) ? x : y with bare-state branches", async () => {
  await expectSameLowering(
    mono(
      "const a = state.f32(1).named('a');\nconst b = state.f32(2).named('b');",
      `out.ch(0).at(i).write(!(input.ch(0).at(i) > 0) ? a : b);`,
    ),
    mono(
      "const a = state.f32(1).named('a');\nconst b = state.f32(2).named('b');",
      `out.ch(0).at(i).write(select(not(gt(input.ch(0).at(i), 0)), a.read(), b.read()));`,
    ),
  );
});

test("ternary: a ternary INSIDE neg — -(c ? x : y)", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(-(input.ch(0).at(i) > 0 ? f32(1) : f32(2)));`,
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? -1 : -2, 6);
});

test("ternary: structural — -(c ? x : y) == neg(select(c, x, y))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(-(input.ch(0).at(i) > 0 ? f32(1) : f32(2)));`),
    mono("", `out.ch(0).at(i).write(neg(select(gt(input.ch(0).at(i), 0), f32(1), f32(2))));`),
  );
});

test("ternary: numeric-literal branches lift to the output (f32) type and select", async () => {
  const x = ramp();
  const got = await renderRamp(`out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? 1 : -1);`);
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? 1 : -1, 6);
});

test("ternary: structural — numeric-literal branches stay JS numbers in select", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? 1 : -1);`),
    mono("", `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0), 1, -1));`),
  );
});

test("ternary: a JS-boolean condition leaves the ?: as a BUILD-TIME expression", async () => {
  // N5 = 5 is build-time; `N5 > 3` is a JS boolean, so the ternary does NOT lower
  // to select — it stays a JS conditional that build-time-picks the Node branch.
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(N5 > 3 ? input.ch(0).at(i) : f32(0));`,
    "const N5 = 5;",
  );
  // 5 > 3 is true at build time → the input branch is the only graph node.
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(x[n]!), 6);
});

test("ternary: a JS-boolean condition false-branch is build-time-selected", async () => {
  const got = await renderRamp(
    `out.ch(0).at(i).write(N2 > 3 ? input.ch(0).at(i) : f32(0));`,
    "const N2 = 2;",
  );
  // 2 > 3 is false at build time → constant f32(0) graph.
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(0, 6);
});

test("ternary: chained — a ? b : c ? d : e ? f : g (right-associative)", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(input.ch(0).at(i) > 0.5 ? f32(3) : input.ch(0).at(i) > 0 ? f32(2) : input.ch(0).at(i) > -0.5 ? f32(1) : f32(0));`,
  );
  for (let n = 0; n < N; n++) {
    const v = x[n]!;
    const expected = v > 0.5 ? 3 : v > 0 ? 2 : v > -0.5 ? 1 : 0;
    expect(got[n]).toBeCloseTo(expected, 6);
  }
});

test("ternary: structural — chained right-associative nest", async () => {
  await expectSameLowering(
    mono(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i) > 0.5 ? f32(3) : input.ch(0).at(i) > 0 ? f32(2) : f32(1));`,
    ),
    mono(
      "",
      `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0.5), f32(3), select(gt(input.ch(0).at(i), 0), f32(2), f32(1))));`,
    ),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// adversarial combinations
// ───────────────────────────────────────────────────────────────────────────

test("combo: -a inside a ternary branch — c ? -a : a", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? -input.ch(0).at(i) : input.ch(0).at(i));`,
  );
  for (let n = 0; n < N; n++) {
    const expected = x[n]! > 0 ? f32(-x[n]!) : x[n]!;
    expect(got[n]).toBeCloseTo(expected, 6);
  }
});

test("combo: structural — c ? -a : a == select(c, neg(a), a)", async () => {
  await expectSameLowering(
    mono(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i) > 0 ? -input.ch(0).at(i) : input.ch(0).at(i));`,
    ),
    mono(
      "",
      `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0), neg(input.ch(0).at(i)), input.ch(0).at(i)));`,
    ),
  );
});

test("combo: a ternary feeding an arithmetic op — (c ? a : b) + 1", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write((input.ch(0).at(i) > 0 ? f32(2) : f32(4)) + 1);`,
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? 3 : 5, 6);
});

test("combo: not over a chained comparison feeding select condition", async () => {
  // select(not(a > 0), 1, 0) == 1 when a <= 0.
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(select(!(input.ch(0).at(i) > 0), f32(1), f32(0)));`,
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(x[n]! > 0 ? 0 : 1, 6);
});

test("combo: abs via ternary — c < 0 ? -c : c equals |c|", async () => {
  const x = ramp();
  const got = await renderRamp(
    `out.ch(0).at(i).write(input.ch(0).at(i) < 0 ? -input.ch(0).at(i) : input.ch(0).at(i));`,
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(f32(Math.abs(x[n]!)), 6);
});

// ───────────────────────────────────────────────────────────────────────────
// integer / bool behavioral edges (int negation, sign, !! false path)
// ───────────────────────────────────────────────────────────────────────────

test("int: -n on an i32 state is integer negation (n=-5 → 5)", async () => {
  const got = await renderRamp(
    `out.ch(0).at(i).write(f32(-n));`,
    "const n = state.i32(-5).named('n');",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(5, 6);
});

test("int: i32 ternary selecting a negated state — n>0 ? -n : n", async () => {
  const got = await renderRamp(
    `out.ch(0).at(i).write(f32(n > i32(0) ? -n : n));`,
    "const n = state.i32(3).named('n');",
  );
  // n defaults 3 > 0 → -3.
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(-3, 6);
});

test("int: i64 negation flows through i32 then f32 (m=7n → -7)", async () => {
  const got = await renderRamp(
    `out.ch(0).at(i).write(f32(i32(-m)));`,
    "const m = state.i64(7n).named('m');",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(-7, 6);
});

test("int: structural — i64 neg on a bare state reads then negates", async () => {
  await expectSameLowering(
    mono("const m = state.i64(5n).named('m');", `m.write(-m);`),
    mono("const m = state.i64(5n).named('m');", `m.write(neg(m.read()));`),
  );
});

test("bool: !!c on a false-default state takes the else branch (→ 0)", async () => {
  const got = await renderRamp(
    `out.ch(0).at(i).write(select(!!c, f32(1), f32(0)));`,
    "const c = state.bool(false).named('c');",
  );
  for (let n = 0; n < N; n++) expect(got[n]).toBeCloseTo(0, 6);
});
