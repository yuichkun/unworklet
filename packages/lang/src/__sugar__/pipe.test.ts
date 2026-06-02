/**
 * EXHAUSTIVE bit-identity + behavioral tests for `pipe` composition in `.uwk.ts`.
 *
 * `pipe` is NOT itself sugar — `pipe` (free fn) and `Node<T>.pipe(fn)` (method)
 * are passthrough authoring identifiers re-exported by `@unworklet/core`. What the
 * lowering DOES do is fire the OPERATOR / ternary / bare-state sugar INSIDE the
 * helper-function bodies and around the pipe expression, because dispatch is
 * type-directed (a `(v: Node<"f32">) => v * 2` helper has a Node-typed param, so
 * `v * 2` lowers to `mul(v, 2)`). The `pipe(...)` call site itself is left intact.
 *
 * Two oracles (see `../goldenHarness.ts`):
 *  - `expectSameLowering(sugar, explicit)` — the `explicit` form is hand-written
 *    chain DSL (NO operator sugar; helper bodies written as `.mul(2)` etc., pipe
 *    used as-is) and is GROUND TRUTH. Structural equivalence of the lowered graph.
 *  - `renderLowered` + a pure-JS reference — the high-confidence SEMANTIC probe.
 *    `pipe(x, f, g)` ≡ `g(f(x))`; the JS reference composes the same way. The
 *    single output port is `f32`, and every algebraic per-op f32 result is
 *    `Math.fround`ed, so the reference rounds per op (matching the WASM f32 math
 *    exactly — no slack needed for `+ - * /` / abs over f32-clean values).
 *  - For TRANSCENDENTALS (`tanh`): WASM's polynomial approx differs from libm
 *    `Math.tanh` by a ULP or two, so an exact JS reference is unreliable. The
 *    equivalence that pipe must guarantee is purely structural — `pipe(x, f) ≡
 *    f(x)` — so we render BOTH the piped form and the direct/nested form and
 *    assert the WASM outputs are byte-equal (`pipeEqualsDirect`). This pins the
 *    composition without depending on a transcendental's exact value.
 *
 * Contract exercised:
 *  - `pipe(x)` identity ≡ x.
 *  - `pipe(x, f)` ≡ `f(x)`; `x.pipe(f)` ≡ `f(x)`.
 *  - `pipe(x, f, g, h, ...)` left-to-right ≡ `...h(g(f(x)))`.
 *  - operator/ternary/bare-state sugar fires INSIDE helper bodies (typed param).
 *  - pipe result is a Node, so surrounding operator sugar lowers around it,
 *    preserving JS precedence (`x.abs().pipe(sc) * gain`, `pipe(a,f) + pipe(b,f)`).
 *  - the argument to pipe may itself be a sugar operator expr (`pipe(x*2, f)`).
 *  - int-typed helpers (i32 truncation, etc.) compose with the right width.
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

const W = (expr: string): string => `out.ch(0).at(i).write(${expr});`;
const A = "input.ch(0).at(i)";

/** Render a mono body with a constant input; return output[0][0]. */
async function firstOut(decls: string, body: string, inval: number): Promise<number> {
  const x = new Float32Array(128).fill(inval);
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  return r.outputs.main![0]![0]!;
}

// f32 per-op references — input read from a Float32Array is already f32-exact.
const add32 = (a: number, b: number): number => fr(a + b);
const sub32 = (a: number, b: number): number => fr(a - b);
const mul32 = (a: number, b: number): number => fr(a * b);
const abs32 = (a: number): number => fr(Math.abs(a));

/**
 * Assert two mono bodies render to byte-identical WASM output for a constant
 * input. Used where the body involves a transcendental (`tanh`) whose exact f32
 * value diverges from libm `Math.tanh` — the property under test is composition
 * equivalence, so a piped form vs its hand-composed form is the right oracle.
 */
async function pipeEqualsDirect(
  decls: string,
  pipedExpr: string,
  directExpr: string,
  inval: number,
): Promise<void> {
  const piped = await firstOut(decls, W(pipedExpr), inval);
  const direct = await firstOut(decls, W(directExpr), inval);
  expect(piped).toBe(direct);
}

// Common helper-decl strings reused across tests.
const H_DOUBLE = `const double = (v: Node<"f32">) => v * 2;`;
const H_DOUBLE_X = `const double = (v: Node<"f32">) => v.mul(2);`; // explicit
const H_SOFTCLIP = `const softclip = (v: Node<"f32">) => v.tanh();`;
const H_DC = `const dc = (v: Node<"f32">) => v - 0.5;`;
const H_DC_X = `const dc = (v: Node<"f32">) => v.sub(0.5);`; // explicit

// ════════════════════════════════════════════════════════════════════════════
// 1. Identity — pipe(x) with no functions
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: pipe(x) identity returns x unchanged", async () => {
  expect(await firstOut("", W(`pipe(${A})`), 0.7)).toBe(fr(0.7));
  expect(await firstOut("", W(`pipe(${A})`), -0.42)).toBe(fr(-0.42));
});

test("STRUCTURAL: pipe(x) identity ≡ writing x directly", async () => {
  await expectSameLowering(mono("", W(`pipe(${A})`)), mono("", W(A)));
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Single-stage — free fn vs method, named helper vs ambient primitive
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: pipe(x, double) ≡ double(x) (helper operator lifts to mul)", async () => {
  expect(await firstOut(H_DOUBLE, W(`pipe(${A}, double)`), 0.3)).toBe(mul32(fr(0.3), 2));
});

test("SEMANTIC: x.pipe(double) method form ≡ double(x)", async () => {
  expect(await firstOut(H_DOUBLE, W(`${A}.pipe(double)`), 0.3)).toBe(mul32(fr(0.3), 2));
});

test("SEMANTIC: pipe(x, abs) with ambient primitive ≡ abs(x)", async () => {
  expect(await firstOut("", W(`pipe(${A}, abs)`), -0.6)).toBe(abs32(-0.6));
});

test("SEMANTIC: pipe(x, softclip) ≡ tanh(x) (WASM-vs-WASM, ULP-safe)", async () => {
  await pipeEqualsDirect(H_SOFTCLIP, `pipe(${A}, softclip)`, `softclip(${A})`, 0.9);
});

test("STRUCTURAL: pipe(x, double) sugar ≡ pipe(x, doubleExplicit)", async () => {
  await expectSameLowering(
    mono(H_DOUBLE, W(`pipe(${A}, double)`)),
    mono(H_DOUBLE_X, W(`pipe(${A}, double)`)),
  );
});

test("STRUCTURAL: x.pipe(double) sugar ≡ explicit-body x.pipe(double)", async () => {
  await expectSameLowering(
    mono(H_DOUBLE, W(`${A}.pipe(double)`)),
    mono(H_DOUBLE_X, W(`${A}.pipe(double)`)),
  );
});

test("STRUCTURAL: pipe(x, f) ≡ f(x) (named-helper call, no pipe)", async () => {
  await expectSameLowering(
    mono(H_DOUBLE, W(`pipe(${A}, double)`)),
    mono(H_DOUBLE, W(`double(${A})`)),
  );
});

test("STRUCTURAL: x.pipe(f) ≡ f(x)", async () => {
  await expectSameLowering(
    mono(H_DOUBLE, W(`${A}.pipe(double)`)),
    mono(H_DOUBLE, W(`double(${A})`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Composition order — multi-stage left-to-right
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: pipe(x, abs, double) ≡ double(abs(x)) (order matters)", async () => {
  // abs then *2: |-1.5| * 2 = 3
  expect(await firstOut(H_DOUBLE, W(`pipe(${A}, abs, double)`), -1.5)).toBe(mul32(abs32(-1.5), 2));
});

test("SEMANTIC: pipe(x, double, abs) ≡ abs(double(x)) — swapped order DIFFERS", async () => {
  // *2 then abs: |-1.5 * 2| = 3 ... pick a value where order matters more sharply
  // x = -1.5: double->abs = |−3| = 3 ; abs->double = |−1.5|*2 = 3 (same). Use a value
  // that distinguishes: with a subtractive helper it diverges; here both abs+double
  // commute on sign, so instead verify the *value path*:
  const x = -0.4;
  expect(await firstOut(H_DOUBLE, W(`pipe(${A}, double, abs)`), x)).toBe(abs32(mul32(fr(x), 2)));
});

test("SEMANTIC: order divergence — pipe(x, dc, abs) vs pipe(x, abs, dc)", async () => {
  // dc: v-0.5 ; abs. With x=0.3:
  //   dc then abs: |0.3-0.5| = 0.2
  //   abs then dc: |0.3|-0.5 = -0.2
  const x = 0.3;
  const dcThenAbs = abs32(sub32(fr(x), 0.5));
  const absThenDc = sub32(abs32(fr(x)), 0.5);
  expect(dcThenAbs).not.toBe(absThenDc); // the two orders genuinely differ
  expect(await firstOut(H_DC, W(`pipe(${A}, dc, abs)`), x)).toBe(dcThenAbs);
  expect(await firstOut(H_DC, W(`pipe(${A}, abs, dc)`), x)).toBe(absThenDc);
});

test("SEMANTIC: deep 4-stage pipe(x, abs, double, dc, softclip) ≡ nested calls", async () => {
  // |x| -> *2 -> -0.5 -> tanh ; transcendental tail, so compare WASM-vs-WASM.
  const decls = `${H_DOUBLE}\n${H_DC}\n${H_SOFTCLIP}`;
  await pipeEqualsDirect(
    decls,
    `pipe(${A}, abs, double, dc, softclip)`,
    `softclip(dc(double(abs(${A}))))`,
    -0.7,
  );
});

test("STRUCTURAL: pipe(x, abs, double) ≡ double(abs(x)) nested calls", async () => {
  await expectSameLowering(
    mono(H_DOUBLE, W(`pipe(${A}, abs, double)`)),
    mono(H_DOUBLE, W(`double(abs(${A}))`)),
  );
});

test("STRUCTURAL: pipe(x, abs, double, dc, softclip) ≡ explicit-body equivalent", async () => {
  const decls = `${H_DOUBLE}\n${H_DC}\n${H_SOFTCLIP}`;
  const declsX = `${H_DOUBLE_X}\n${H_DC_X}\n${H_SOFTCLIP}`;
  await expectSameLowering(
    mono(decls, W(`pipe(${A}, abs, double, dc, softclip)`)),
    mono(declsX, W(`pipe(${A}, abs, double, dc, softclip)`)),
  );
});

test("STRUCTURAL: pipe(x, abs, double, dc, softclip) ≡ fully-nested call chain", async () => {
  const declsX = `${H_DOUBLE_X}\n${H_DC_X}\n${H_SOFTCLIP}`;
  await expectSameLowering(
    mono(`${H_DOUBLE}\n${H_DC}\n${H_SOFTCLIP}`, W(`pipe(${A}, abs, double, dc, softclip)`)),
    mono(declsX, W(`softclip(dc(double(abs(${A}))))`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Chained method pipes — x.pipe(a).pipe(b)
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: x.pipe(abs).pipe(double) ≡ double(abs(x))", async () => {
  expect(await firstOut(H_DOUBLE, W(`${A}.pipe(abs).pipe(double)`), -1.25)).toBe(
    mul32(abs32(-1.25), 2),
  );
});

test("SEMANTIC: x.pipe(dc).pipe(softclip) chained — order preserved", async () => {
  await pipeEqualsDirect(
    `${H_DC}\n${H_SOFTCLIP}`,
    `${A}.pipe(dc).pipe(softclip)`,
    `softclip(dc(${A}))`,
    0.8,
  );
});

test("STRUCTURAL: x.pipe(abs).pipe(double) ≡ free pipe(x, abs, double)", async () => {
  await expectSameLowering(
    mono(H_DOUBLE, W(`${A}.pipe(abs).pipe(double)`)),
    mono(H_DOUBLE, W(`pipe(${A}, abs, double)`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 5. pipe combined with surrounding operators — precedence around the pipe node
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: x.abs().pipe(softclip) * gain — pipe binds before *", async () => {
  // tanh(|x|) * 0.5  (NOT tanh(|x| * 0.5)). Render both groupings: the correct
  // grouping must match the WASM nested form AND differ from the wrong grouping.
  const x = -0.9;
  await pipeEqualsDirect(
    H_SOFTCLIP,
    `${A}.abs().pipe(softclip) * 0.5`,
    `softclip(${A}.abs()) * 0.5`,
    x,
  );
  const right = await firstOut(H_SOFTCLIP, W(`${A}.abs().pipe(softclip) * 0.5`), x);
  const wrong = await firstOut(H_SOFTCLIP, W(`softclip((${A}.abs()) * 0.5)`), x); // tanh(|x|*0.5)
  expect(right).not.toBe(wrong); // proves pipe binds before *, not after
});

test("SEMANTIC: pipe(x, softclip) + pipe(x, softclip) — pipe in both operands", async () => {
  await pipeEqualsDirect(
    H_SOFTCLIP,
    `pipe(${A}, softclip) + pipe(${A}, softclip)`,
    `softclip(${A}) + softclip(${A})`,
    0.6,
  );
});

test("SEMANTIC: 1 - pipe(x, softclip) — pipe result on the right of sub", async () => {
  await pipeEqualsDirect(H_SOFTCLIP, `1 - pipe(${A}, softclip)`, `1 - softclip(${A})`, 0.5);
});

test("SEMANTIC: pipe(x, double) + pipe(x, abs) — mixed helpers, additive", async () => {
  const x = -0.4;
  expect(await firstOut(`${H_DOUBLE}`, W(`pipe(${A}, double) + pipe(${A}, abs)`), x)).toBe(
    add32(mul32(fr(x), 2), abs32(fr(x))),
  );
});

test("SEMANTIC: (x.pipe(softclip) + 1) * 2 — parens around pipe-bearing add", async () => {
  await pipeEqualsDirect(
    H_SOFTCLIP,
    `(${A}.pipe(softclip) + 1) * 2`,
    `(softclip(${A}) + 1) * 2`,
    0.3,
  );
});

test("STRUCTURAL: x.abs().pipe(softclip) * 0.5 ≡ mul(x.abs().pipe(softclip), 0.5)", async () => {
  await expectSameLowering(
    mono(H_SOFTCLIP, W(`${A}.abs().pipe(softclip) * 0.5`)),
    mono(H_SOFTCLIP, W(`mul(${A}.abs().pipe(softclip), 0.5)`)),
  );
});

test("STRUCTURAL: pipe(x, sc) + pipe(x, sc) ≡ add(pipe(x, sc), pipe(x, sc))", async () => {
  await expectSameLowering(
    mono(H_SOFTCLIP, W(`pipe(${A}, softclip) + pipe(${A}, softclip)`)),
    mono(H_SOFTCLIP, W(`add(pipe(${A}, softclip), pipe(${A}, softclip))`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 6. pipe argument is itself a sugar operator expression
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: pipe(x * 2, softclip) — arg is an operator expr", async () => {
  await pipeEqualsDirect(H_SOFTCLIP, `pipe(${A} * 2, softclip)`, `softclip(${A} * 2)`, 0.4);
});

test("SEMANTIC: pipe(x + 0.1, abs, double) — operator arg + multi-stage", async () => {
  const x = -0.55;
  expect(await firstOut(H_DOUBLE, W(`pipe(${A} + 0.1, abs, double)`), x)).toBe(
    mul32(abs32(add32(fr(x), 0.1)), 2),
  );
});

test("SEMANTIC: (-x).pipe(softclip) — unary-neg arg to method pipe", async () => {
  await pipeEqualsDirect(H_SOFTCLIP, `(-${A}).pipe(softclip)`, `softclip(-${A})`, 0.7);
});

test("STRUCTURAL: pipe(x * 2, softclip) ≡ pipe(mul(x, 2), softclip)", async () => {
  await expectSameLowering(
    mono(H_SOFTCLIP, W(`pipe(${A} * 2, softclip)`)),
    mono(H_SOFTCLIP, W(`pipe(mul(${A}, 2), softclip)`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Inline arrow lambda directly in pipe (typed param → operator lifts)
// ════════════════════════════════════════════════════════════════════════════

test('SEMANTIC: pipe(x, (v: Node<"f32">) => v * 2) inline lambda lifts operator', async () => {
  expect(await firstOut("", W(`pipe(${A}, (v: Node<"f32">) => v * 2)`), 0.35)).toBe(
    mul32(fr(0.35), 2),
  );
});

test('SEMANTIC: pipe(x, (v: Node<"f32">) => v.abs(), (v: Node<"f32">) => v - 0.25)', async () => {
  const x = -0.6;
  expect(
    await firstOut(
      "",
      W(`pipe(${A}, (v: Node<"f32">) => v.abs(), (v: Node<"f32">) => v - 0.25)`),
      x,
    ),
  ).toBe(sub32(abs32(fr(x)), 0.25));
});

test("STRUCTURAL: inline typed lambda v*2 ≡ inline v.mul(2)", async () => {
  await expectSameLowering(
    mono("", W(`pipe(${A}, (v: Node<"f32">) => v * 2)`)),
    mono("", W(`pipe(${A}, (v: Node<"f32">) => v.mul(2))`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Ternary / comparison sugar inside a helper body, threaded by pipe
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: pipe(x, clip) where clip = v > 1 ? f32(1) : v (above)", async () => {
  // x = 2.0 > 1 -> 1
  expect(
    await firstOut(
      `const clip = (v: Node<"f32">) => v > 1 ? f32(1) : v;`,
      W(`pipe(${A}, clip)`),
      2.0,
    ),
  ).toBe(1);
});

test("SEMANTIC: pipe(x, clip) where clip = v > 1 ? f32(1) : v (below passes through)", async () => {
  expect(
    await firstOut(
      `const clip = (v: Node<"f32">) => v > 1 ? f32(1) : v;`,
      W(`pipe(${A}, clip)`),
      0.3,
    ),
  ).toBe(fr(0.3));
});

test("STRUCTURAL: helper ternary body sugar ≡ explicit select", async () => {
  await expectSameLowering(
    mono(`const clip = (v: Node<"f32">) => v > 1 ? f32(1) : v;`, W(`pipe(${A}, clip)`)),
    mono(`const clip = (v: Node<"f32">) => select(gt(v, 1), f32(1), v);`, W(`pipe(${A}, clip)`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Integer-typed helpers — composition with the right width
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: i32 helper pipe — truncating divide composes correctly", async () => {
  // i32(7) -> (v) => v/i32(2) [trunc] -> 3 ; cast to f32 for the f32 output port.
  const decls = `const half = (v: Node<"i32">) => v / i32(2);`;
  expect(await firstOut(decls, W(`f32(pipe(i32(7), half))`), 0)).toBe(fr(3));
});

test("SEMANTIC: i32 helper pipe two-stage — (v*3) then (v-1)", async () => {
  const decls = `const a = (v: Node<"i32">) => v * i32(3);\nconst b = (v: Node<"i32">) => v - i32(1);`;
  // i32(5) -> *3 = 15 -> -1 = 14
  expect(await firstOut(decls, W(`f32(pipe(i32(5), a, b))`), 0)).toBe(fr(14));
});

test("STRUCTURAL: i32 helper sugar ≡ explicit chain helper", async () => {
  await expectSameLowering(
    mono(`const half = (v: Node<"i32">) => v / i32(2);`, W(`f32(pipe(i32(7), half))`)),
    mono(`const half = (v: Node<"i32">) => v.div(i32(2));`, W(`f32(pipe(i32(7), half))`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 10. State threaded through a pipe — explicit `s.read()`
//
// NOTE: a bare `State<T>` is NOT auto-read in pipe's FIRST-ARG position. The
// bare-state pass fires only where the contextual type accepts a `Node<...>`;
// pipe's first parameter is the inferred generic `A` (bound to `State<"f32">`),
// not `Node<...>`, so no read-wrap happens — and `pipe(s, helper)` is in fact a
// TYPE ERROR (`(v: Node) => ...` is not assignable to `(x: State) => ...`).
// `s.pipe(helper)` is likewise a type error (`pipe` is a `Node` method, not a
// `State` method). So the only valid form is an explicit `s.read()`, which we
// verify renders correctly. (Compare: `abs(s)` DOES read-wrap, because `abs`'s
// param type `number | Node<"f32">` carries a `Node<...>` contextual type.)
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: pipe(s.read(), double) threads the state value and composes", async () => {
  // s holds 0.5; double = (v) => v * 2 -> 1.0
  const decls = `const s = state.f32(0.5);\n${H_DOUBLE}`;
  expect(await firstOut(decls, W(`pipe(s.read(), double)`), 0)).toBe(mul32(fr(0.5), 2));
});

test("STRUCTURAL: pipe(s.read(), double) ≡ double(s.read())", async () => {
  const decls = `const s = state.f32(0.5);\n${H_DOUBLE}`;
  await expectSameLowering(
    mono(decls, W(`pipe(s.read(), double)`)),
    mono(decls, W(`double(s.read())`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 11. pipe used as a SUBEXPRESSION inside another pipe stage / nested pipe
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: nested pipe(pipe(x, abs), double) ≡ double(abs(x))", async () => {
  expect(await firstOut(H_DOUBLE, W(`pipe(pipe(${A}, abs), double)`), -0.45)).toBe(
    mul32(abs32(-0.45), 2),
  );
});

test("STRUCTURAL: nested pipe ≡ flat pipe(x, abs, double)", async () => {
  await expectSameLowering(
    mono(H_DOUBLE, W(`pipe(pipe(${A}, abs), double)`)),
    mono(H_DOUBLE, W(`pipe(${A}, abs, double)`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Contextual-typing edge: UNTYPED inline lambda param is inferred from pipe
//
// `pipe<A, B>(x: A, f1: (x: A) => B)` binds `A = Node<"f32">` from the first arg,
// so an un-annotated `(v) => v * 2` lambda still gets `v: Node<"f32">` by
// contextual typing — the operator pass therefore lowers `v * 2 → mul(v, 2)`.
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: pipe(x, (v) => v * 2) — UNTYPED param inferred as Node, operator lifts", async () => {
  expect(await firstOut("", W(`pipe(${A}, (v) => v * 2)`), 0.3)).toBe(mul32(fr(0.3), 2));
});

test("STRUCTURAL: untyped inline (v) => v * 2 ≡ (v) => v.mul(2)", async () => {
  await expectSameLowering(
    mono("", W(`pipe(${A}, (v) => v * 2)`)),
    mono("", W(`pipe(${A}, (v) => v.mul(2))`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Comparison-returning helper threaded by pipe, consumed by select
//
// A helper that returns a `Node<"bool">` (from a comparison) composes through
// pipe and feeds a `select` condition.
// ════════════════════════════════════════════════════════════════════════════

test("SEMANTIC: select(pipe(x, gt0), 1, 0) — bool helper through pipe", async () => {
  const decls = `const gt0 = (v: Node<"f32">) => v > 0;`;
  expect(await firstOut(decls, W(`select(pipe(${A}, gt0), f32(1), f32(0))`), 0.5)).toBe(1);
  expect(await firstOut(decls, W(`select(pipe(${A}, gt0), f32(1), f32(0))`), -0.5)).toBe(0);
});

test("STRUCTURAL: pipe(x, gt0) sugar-body ≡ explicit gt(v, 0) body", async () => {
  await expectSameLowering(
    mono(`const gt0 = (v: Node<"f32">) => v > 0;`, W(`select(pipe(${A}, gt0), f32(1), f32(0))`)),
    mono(`const gt0 = (v: Node<"f32">) => gt(v, 0);`, W(`select(pipe(${A}, gt0), f32(1), f32(0))`)),
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 14. pipe result consumed by an OUTER operator — SAFE composition paths
//
// When the final stage returns a genuine `Node` in the PRISTINE type (an ambient
// primitive like `abs`, or a helper with a chain body / explicit return type),
// the outer operator's type-directed dispatch fires correctly: `-pipe(x, abs)`
// → `neg(pipe(...))`, `2 / pipe(x, abs)` → `div(2, pipe(...))`. (A helper with a
// sugar-operator body and NO return annotation infers a `number` return in the
// pristine source and does NOT compose under an outer operator — see report.)
// ════════════════════════════════════════════════════════════════════════════

const H_SC_RET = `const sc = (v: Node<"f32">): Node<"f32"> => v.tanh();`;

test("SEMANTIC: -pipe(x, abs) — ambient final stage composes under unary neg", async () => {
  expect(await firstOut("", W(`-pipe(${A}, abs)`), -0.3)).toBe(fr(-abs32(-0.3)));
});

test("SEMANTIC: 2 / pipe(x, abs) — ambient final stage composes under div", async () => {
  expect(await firstOut("", W(`2 / pipe(${A}, abs)`), 0.5)).toBe(fr(2 / abs32(0.5)));
});

test("SEMANTIC: -pipe(x, sc) — chain-body helper composes under unary neg", async () => {
  // sc returns a real Node (chain body), so the outer neg lowers. Compare WASM
  // vs WASM to stay ULP-safe on tanh.
  await pipeEqualsDirect(H_SC_RET, `-pipe(${A}, sc)`, `neg(pipe(${A}, sc))`, 0.5);
});

test("SEMANTIC: pipe(x, sc) * 0.5 — explicit-return helper composes under mul", async () => {
  await pipeEqualsDirect(H_SC_RET, `pipe(${A}, sc) * 0.5`, `mul(pipe(${A}, sc), 0.5)`, 0.5);
});

test("STRUCTURAL: -pipe(x, abs) ≡ neg(pipe(x, abs))", async () => {
  await expectSameLowering(mono("", W(`-pipe(${A}, abs)`)), mono("", W(`neg(pipe(${A}, abs))`)));
});

test("STRUCTURAL: 2 / pipe(x, abs) ≡ div(2, pipe(x, abs))", async () => {
  await expectSameLowering(
    mono("", W(`2 / pipe(${A}, abs)`)),
    mono("", W(`div(2, pipe(${A}, abs))`)),
  );
});
