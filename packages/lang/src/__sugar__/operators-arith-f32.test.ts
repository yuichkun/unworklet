/**
 * EXHAUSTIVE bit-identity + behavioral tests for arithmetic operator sugar on
 * `f32` Nodes: `+ - * / %` and unary `-`.
 *
 * Two oracles (see `../goldenHarness.ts`):
 *  - `expectSameLowering(sugar, explicit)` — the `explicit` form is hand-written
 *    chain DSL (NO operator sugar) and is GROUND TRUTH. Structural equivalence.
 *  - `renderLowered(uwk, config)` — lower + eval + render, compared to a pure-JS
 *    reference. f32 Node arithmetic is per-op f32-rounded (proven below), so the
 *    JS reference applies `Math.fround` after every op and lifts every numeric
 *    literal through `Math.fround` too. This is what pins down precedence,
 *    literal-lift type (f32 not f64), associativity, and per-op rounding.
 *
 * Lowering contract exercised here:
 *  - a+b → add(a,b); a-b → sub(a,b); a*b → mul(a,b); a/b → div(a,b);
 *    a%b → mod(a,b); -a → neg(a).
 *  - TYPE-DIRECTED: an op lowers ONLY if an operand is/becomes a Node. A pure
 *    `number op number` build-time const STAYS JS (must NOT lower).
 *  - Left-associative: a-b-c → sub(sub(a,b),c), likewise / and %.
 *  - Numeric literals are passed RAW into the chain call; the core lifts them to
 *    the inferred scalar type (f32 here) — so `x + 0.1` rounds 0.1 to f32.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const DUR = 128 / SR;
const fr = Math.fround;

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

/** Fill a 128-sample block with a constant. */
function block(v: number): Float32Array {
  return new Float32Array(128).fill(v);
}

/** Run a body `out = expr(x)` for constant input `x`, return sample 0 of out. */
async function render1(decls: string, body: string, x: number): Promise<number> {
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [block(x)] },
  });
  return r.outputs.main![0]![0]!;
}

// f32 per-op helpers: each binary op rounds its result to f32; the input is read
// from a Float32Array so it is already f32-exact.
const add32 = (a: number, b: number): number => fr(a + b);
const sub32 = (a: number, b: number): number => fr(a - b);
const mul32 = (a: number, b: number): number => fr(a * b);
const div32 = (a: number, b: number): number => fr(a / b);
const mod32 = (a: number, b: number): number => fr(a % b);
const neg32 = (a: number): number => fr(-a);

// ───────────────────────── per-op f32 semantics ─────────────────────────────
// These are the load-bearing semantic proofs: the result is f32 per op, NOT
// f64-then-rounded, and literals lift to f32 (not f64). Adversarial values are
// chosen so the two models DIVERGE — a wrong implementation flips the answer.

test("SEMANTIC: (x + 1e8) - 1e8 collapses to 0 — proves per-op f32 rounding (f64 would give 1)", async () => {
  const got = await render1("", `out.ch(0).at(i).write((input.ch(0).at(i) + 1e8) - 1e8);`, 1.0);
  const perOp = sub32(add32(fr(1.0), fr(1e8)), fr(1e8)); // 0
  const f64model = fr(1.0 + 1e8 - 1e8); // 1 — the WRONG model
  expect(perOp).toBe(0);
  expect(f64model).toBe(1);
  expect(got).toBe(perOp);
});

test("SEMANTIC: x + 0.1 lifts the literal to f32 then adds in f32", async () => {
  const got = await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) + 0.1);`, 0.2);
  expect(got).toBe(add32(fr(0.2), fr(0.1)));
  expect(got).toBeCloseTo(0.3, 6);
});

test("SEMANTIC: x / 3 divides in f32 (1/3 = 0.33333334, the f32 value)", async () => {
  const got = await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 3);`, 1.0);
  expect(got).toBe(div32(fr(1.0), fr(3)));
  expect(got).toBe(fr(1 / 3));
});

test("SEMANTIC: x * x * x is f32 per multiply", async () => {
  const got = await render1(
    "",
    `out.ch(0).at(i).write(input.ch(0).at(i) * input.ch(0).at(i) * input.ch(0).at(i));`,
    0.1,
  );
  const x = fr(0.1);
  expect(got).toBe(mul32(mul32(x, x), x));
});

// ───────────────────────── one op, literal positions ────────────────────────
// node op node, node op literal, literal op node — for each of + - * / %.

test("SEMANTIC: + — node+node, node+lit, lit+node", async () => {
  expect(
    await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) + input.ch(0).at(i));`, 0.3),
  ).toBe(add32(fr(0.3), fr(0.3)));
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) + 0.25);`, 0.3)).toBe(
    add32(fr(0.3), fr(0.25)),
  );
  expect(await render1("", `out.ch(0).at(i).write(0.25 + input.ch(0).at(i));`, 0.3)).toBe(
    add32(fr(0.25), fr(0.3)),
  );
});

test("SEMANTIC: - — node-node, node-lit, lit-node (NON-commutative order matters)", async () => {
  expect(
    await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - input.ch(0).at(i));`, 0.7),
  ).toBe(0);
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - 0.2);`, 0.7)).toBe(
    sub32(fr(0.7), fr(0.2)),
  );
  // lit - node MUST be sub(lit, node), not sub(node, lit): 0.2 - 0.7 = -0.5
  expect(await render1("", `out.ch(0).at(i).write(0.2 - input.ch(0).at(i));`, 0.7)).toBe(
    sub32(fr(0.2), fr(0.7)),
  );
});

test("SEMANTIC: * — node*node, node*lit, lit*node", async () => {
  expect(
    await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) * input.ch(0).at(i));`, 0.4),
  ).toBe(mul32(fr(0.4), fr(0.4)));
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) * 3);`, 0.4)).toBe(
    mul32(fr(0.4), fr(3)),
  );
  expect(await render1("", `out.ch(0).at(i).write(3 * input.ch(0).at(i));`, 0.4)).toBe(
    mul32(fr(3), fr(0.4)),
  );
});

test("SEMANTIC: / — node/node, node/lit, lit/node (NON-commutative)", async () => {
  expect(
    await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / input.ch(0).at(i));`, 0.6),
  ).toBe(1);
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 4);`, 0.6)).toBe(
    div32(fr(0.6), fr(4)),
  );
  // lit / node MUST be div(lit, node): 4 / 0.5 = 8
  expect(await render1("", `out.ch(0).at(i).write(4 / input.ch(0).at(i));`, 0.5)).toBe(
    div32(fr(4), fr(0.5)),
  );
});

test("SEMANTIC: % — node%lit, lit%node (NON-commutative)", async () => {
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) % 0.3);`, 1.0)).toBe(
    mod32(fr(1.0), fr(0.3)),
  );
  // lit % node MUST be mod(lit, node): 7 % 3 = 1
  expect(await render1("", `out.ch(0).at(i).write(7 % input.ch(0).at(i));`, 3.0)).toBe(
    mod32(fr(7), fr(3)),
  );
});

// ───────────────────────── unary negation ───────────────────────────────────

test("SEMANTIC: -x negates in f32", async () => {
  expect(await render1("", `out.ch(0).at(i).write(-input.ch(0).at(i));`, 0.42)).toBe(
    neg32(fr(0.42)),
  );
  expect(await render1("", `out.ch(0).at(i).write(-input.ch(0).at(i));`, -0.42)).toBe(
    neg32(fr(-0.42)),
  );
});

test("SEMANTIC: -x + 5 — neg binds tighter than +", async () => {
  // -(2) + 5 = 3, NOT -(2 + 5) = -7
  expect(await render1("", `out.ch(0).at(i).write(-input.ch(0).at(i) + 5);`, 2.0)).toBe(
    add32(neg32(fr(2.0)), fr(5)),
  );
});

test("SEMANTIC: -x * 3 — neg binds tighter than * — result -6 not |−6|", async () => {
  expect(await render1("", `out.ch(0).at(i).write(-input.ch(0).at(i) * 3);`, 2.0)).toBe(
    mul32(neg32(fr(2.0)), fr(3)),
  );
});

test("SEMANTIC: double negation - -x = x", async () => {
  expect(await render1("", `out.ch(0).at(i).write(- -input.ch(0).at(i));`, 0.33)).toBe(fr(0.33));
});

// ───────────────────────── precedence ───────────────────────────────────────

test("SEMANTIC: x * 2 + 1 — mul binds tighter than add", async () => {
  // (x*2)+1 not x*(2+1)
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) * 2 + 1);`, 3.0)).toBe(
    add32(mul32(fr(3.0), fr(2)), fr(1)),
  );
});

test("SEMANTIC: 1 + x * 2 — mul on the right binds first", async () => {
  expect(await render1("", `out.ch(0).at(i).write(1 + input.ch(0).at(i) * 2);`, 3.0)).toBe(
    add32(fr(1), mul32(fr(3.0), fr(2))),
  );
});

test("SEMANTIC: x / 2 + x — div binds tighter than add", async () => {
  // (x/2)+x = 1.5x+... for x=3 -> 4.5
  expect(
    await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 2 + input.ch(0).at(i));`, 3.0),
  ).toBe(add32(div32(fr(3.0), fr(2)), fr(3.0)));
});

test("SEMANTIC: x - 1 * 2 — mul binds tighter, then sub", async () => {
  // x - (1*2). NOTE 1*2 is number op number -> stays JS = 2, then sub(x, 2)
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - 1 * 2);`, 5.0)).toBe(
    sub32(fr(5.0), fr(2)),
  );
});

test("SEMANTIC: x % 4 + 1 — mod binds tighter than add", async () => {
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) % 4 + 1);`, 7.0)).toBe(
    add32(mod32(fr(7.0), fr(4)), fr(1)),
  );
});

test("SEMANTIC: parens override precedence — (x + 1) * 2", async () => {
  expect(await render1("", `out.ch(0).at(i).write((input.ch(0).at(i) + 1) * 2);`, 3.0)).toBe(
    mul32(add32(fr(3.0), fr(1)), fr(2)),
  );
});

// ───────────────────────── left-associativity ───────────────────────────────

test("SEMANTIC: x - 1 - 2 = (x-1)-2 (left-assoc), NOT x-(1-2)", async () => {
  // (5-1)-2 = 2 ; x-(1-2) = x+1 = 6 — these differ, so assoc is observable
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - 1 - 2);`, 5.0)).toBe(
    sub32(sub32(fr(5.0), fr(1)), fr(2)),
  );
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - 1 - 2);`, 5.0)).toBe(2);
});

test("SEMANTIC: x / 2 / 4 = (x/2)/4 (left-assoc)", async () => {
  // (8/2)/4 = 1 ; x/(2/4) = 8/0.5 = 16 — observable
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 2 / 4);`, 8.0)).toBe(
    div32(div32(fr(8.0), fr(2)), fr(4)),
  );
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 2 / 4);`, 8.0)).toBe(1);
});

test("SEMANTIC: x % 5 % 3 = (x%5)%3 (left-assoc)", async () => {
  // (13%5)%3 = 3%3 = 0 ; x%(5%3) = 13%2 = 1 — observable
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) % 5 % 3);`, 13.0)).toBe(
    mod32(mod32(fr(13.0), fr(5)), fr(3)),
  );
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) % 5 % 3);`, 13.0)).toBe(0);
});

test("SEMANTIC: x - x + x = (x-x)+x left-assoc with three Nodes", async () => {
  // (x-x)+x = x ; x-(x+x) = -x — observable
  expect(
    await render1(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i) - input.ch(0).at(i) + input.ch(0).at(i));`,
      0.9,
    ),
  ).toBe(fr(0.9));
});

// ───────────────────────── deep nesting ─────────────────────────────────────

test("SEMANTIC: deep nest x*2 + x*3 - x/2", async () => {
  const got = await render1(
    "",
    `out.ch(0).at(i).write(input.ch(0).at(i) * 2 + input.ch(0).at(i) * 3 - input.ch(0).at(i) / 2);`,
    4.0,
  );
  const x = fr(4.0);
  const ref = sub32(add32(mul32(x, fr(2)), mul32(x, fr(3))), div32(x, fr(2)));
  expect(got).toBe(ref);
});

test("SEMANTIC: chained 5 adds with literals", async () => {
  const got = await render1(
    "",
    `out.ch(0).at(i).write(input.ch(0).at(i) + 0.1 + 0.2 + 0.3 + 0.4);`,
    0.5,
  );
  const ref = add32(add32(add32(add32(fr(0.5), fr(0.1)), fr(0.2)), fr(0.3)), fr(0.4));
  expect(got).toBe(ref);
});

// ───────────────────────── adversarial: literal-lift type ───────────────────

test("SEMANTIC: x * 0.5 — fractional literal is NOT i32-truncated (proves f32 lift)", async () => {
  // If 0.5 lifted to i32(0)=0 the result would be 0. It must lift to f32(0.5).
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) * 0.5);`, 3.0)).toBe(
    mul32(fr(3.0), fr(0.5)),
  );
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) * 0.5);`, 3.0)).toBe(1.5);
});

test("SEMANTIC: integer literal 2 and decimal 2.0 lift to the same f32 — x/2 === x/2.0", async () => {
  const a = await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 2);`, 0.7);
  const b = await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 2.0);`, 0.7);
  expect(a).toBe(b);
  expect(a).toBe(div32(fr(0.7), fr(2)));
});

// ───────────────────────── adversarial: special values ──────────────────────

// Non-finite semantics are observed THROUGH a finite probe: the value itself
// (+Inf / NaN) exists in-expression, but the audio-output boundary scrubs
// non-finite samples to 0 (issue #27) — so writing it raw asserts the scrub,
// and the probe asserts the in-expression semantics.

test("SEMANTIC: x / 0 → +Infinity in-expression; the output boundary scrubs the raw write to 0", async () => {
  // +Inf compares greater than the largest finite f32 (3.4e38 < f32 max).
  expect(
    await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 0 > 3.4e38 ? 1 : 0);`, 1.0),
  ).toBe(1);
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) / 0);`, 1.0)).toBe(0);
});

test("SEMANTIC: 0 / x with x=0 → NaN in-expression; the output boundary scrubs the raw write to 0", async () => {
  // NaN is the only value that differs from itself.
  expect(
    await render1(
      "",
      `out.ch(0).at(i).write(0 / input.ch(0).at(i) != 0 / input.ch(0).at(i) ? 1 : 0);`,
      0.0,
    ),
  ).toBe(1);
  expect(await render1("", `out.ch(0).at(i).write(0 / input.ch(0).at(i));`, 0.0)).toBe(0);
});

test("SEMANTIC: x % 0 → NaN in-expression (matches JS remainder); the output boundary scrubs the raw write to 0", async () => {
  expect(
    await render1(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i) % 0 != input.ch(0).at(i) % 0 ? 1 : 0);`,
      1.0,
    ),
  ).toBe(1);
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) % 0);`, 1.0)).toBe(0);
});

test("SEMANTIC: -x % 3 → -1 — f32 mod is truncated remainder (sign of dividend, matches JS %)", async () => {
  // -7 % 3 = -1 in JS truncated remainder; NOT +2 (Euclidean).
  expect(await render1("", `out.ch(0).at(i).write(-input.ch(0).at(i) % 3);`, 7.0)).toBe(
    mod32(neg32(fr(7.0)), fr(3)),
  );
  expect(await render1("", `out.ch(0).at(i).write(-input.ch(0).at(i) % 3);`, 7.0)).toBe(-1);
});

// ───────────────────────── adversarial: negative literals ───────────────────

test("SEMANTIC: x - -2 = x + 2 (negative literal on right of sub)", async () => {
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - -2);`, 3.0)).toBe(
    sub32(fr(3.0), fr(-2)),
  );
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - -2);`, 3.0)).toBe(5);
});

test("SEMANTIC: x * -3 = -3x (negative literal factor)", async () => {
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) * -3);`, 2.0)).toBe(
    mul32(fr(2.0), fr(-3)),
  );
  expect(await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) * -3);`, 2.0)).toBe(-6);
});

// ───────────────────────── adversarial: leading-literal associativity ───────

test("SEMANTIC: 8 / x / 2 = (8/x)/2 — leading literal, left-assoc with a Node middle", async () => {
  // (8/4)/2 = 1 ; 8/(x/2) = 8/2 = 4 — observable
  expect(await render1("", `out.ch(0).at(i).write(8 / input.ch(0).at(i) / 2);`, 4.0)).toBe(
    div32(div32(fr(8), fr(4.0)), fr(2)),
  );
  expect(await render1("", `out.ch(0).at(i).write(8 / input.ch(0).at(i) / 2);`, 4.0)).toBe(1);
});

test("SEMANTIC: const var operand stays raw — x + N (N=7) === x + 7", async () => {
  expect(await render1("const N = 7;", `out.ch(0).at(i).write(input.ch(0).at(i) + N);`, 1.0)).toBe(
    add32(fr(1.0), fr(7)),
  );
  expect(await render1("const N = 7;", `out.ch(0).at(i).write(input.ch(0).at(i) + N);`, 1.0)).toBe(
    8,
  );
});

// ───────────────────────── const-fold MUST stay JS ──────────────────────────
// number op number is build-time; it must NOT lower (no add(2,3)), and the
// folded constant feeds the surrounding Node op verbatim.

test("STRUCT: number+number stays JS const (x + (2+3)) === x + 5", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) + (2 + 3));`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).add(5));`),
  );
});

test("STRUCT: const var arithmetic stays JS (x * (N * 2)) === x * 128 for N=64", async () => {
  await expectSameLowering(
    mono("const N = 64;", `out.ch(0).at(i).write(input.ch(0).at(i) * (N * 2));`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).mul(128));`),
  );
});

test("SEMANTIC: Math.round build-time const folds into f32 op", async () => {
  // Math.round(SR*0.001*1000) = 48000 stays JS; sub in f32 with a Node
  const got = await render1("", `out.ch(0).at(i).write(input.ch(0).at(i) - Math.round(2.6));`, 5.0);
  expect(got).toBe(sub32(fr(5.0), fr(3))); // Math.round(2.6)=3
});

// ───────────────────────── structural equivalence (ground-truth chain) ──────
// expectSameLowering vs hand-written chain DSL: catches structural drift the
// behavioral oracle can't (e.g. wrong arg order that happens to be symmetric).

test("STRUCT: + === .add", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) + 0.5);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).add(0.5));`),
  );
});

test("STRUCT: - === .sub (literal on right)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) - 0.5);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).sub(0.5));`),
  );
});

test("STRUCT: lit - node === sub(lit, node)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(0.5 - input.ch(0).at(i));`),
    mono("", `out.ch(0).at(i).write(sub(0.5, input.ch(0).at(i)));`),
  );
});

test("STRUCT: * === .mul", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) * 2);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).mul(2));`),
  );
});

test("STRUCT: / === .div (lit on right) and lit/node === div(lit,node)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) / 2);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).div(2));`),
  );
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(8 / input.ch(0).at(i));`),
    mono("", `out.ch(0).at(i).write(div(8, input.ch(0).at(i)));`),
  );
});

test("STRUCT: % === .mod", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) % 3);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).mod(3));`),
  );
});

test("STRUCT: -x === .neg", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(-input.ch(0).at(i));`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).neg());`),
  );
});

test("STRUCT: left-assoc a-b-c === sub(sub(a,b),c)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) - 1 - 2);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).sub(1).sub(2));`),
  );
});

test("STRUCT: precedence x*2+1 === x.mul(2).add(1)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) * 2 + 1);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).mul(2).add(1));`),
  );
});

test("STRUCT: deep nest === explicit chain", async () => {
  await expectSameLowering(
    mono(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i) * 2 + input.ch(0).at(i) * 3 - input.ch(0).at(i) / 2);`,
    ),
    mono(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i).mul(2).add(input.ch(0).at(i).mul(3)).sub(input.ch(0).at(i).div(2)));`,
    ),
  );
});

test("STRUCT: -x + 5 === x.neg().add(5)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(-input.ch(0).at(i) + 5);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).neg().add(5));`),
  );
});

test("STRUCT: parenthesized (x+1)*2 === x.add(1).mul(2)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write((input.ch(0).at(i) + 1) * 2);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).add(1).mul(2));`),
  );
});
