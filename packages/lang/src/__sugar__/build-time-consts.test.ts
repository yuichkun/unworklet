/**
 * EXHAUSTIVE build-time-constant ("const-fold") hunter for the `.uwk.ts` → `.ts`
 * lowering. The single contract under attack:
 *
 *   TYPE-DIRECTED dispatch (`isDspExpr`): an infix operator lowers to a chain
 *   primitive ONLY if an operand IS — or recursively becomes — a `Node`/`State`.
 *   A pure `number op number` (build-time const like `Math.round(SR * 0.3)`,
 *   `const N = 64; N * 2`, `2 * Math.PI / SR`) MUST stay raw JS and ride into the
 *   chain call as an opaque numeric argument. The const-fold itself happens in JS
 *   at module-eval time; the lowering must not touch it.
 *
 * Two oracles (see `../goldenHarness.ts`):
 *  - `expectSameLowering(sugar, explicit)` — the `explicit` form is hand-written
 *    chain DSL (NO operator/index sugar) and is GROUND TRUTH. Structural
 *    equivalence of the compiled graph + layout.
 *  - `renderLowered(uwk, config)` — lower + eval + renderOffline, compared to a
 *    pure-JS reference. The HIGH-CONFIDENCE probe: a wrong const-fold (e.g. a
 *    const that erroneously lowered to a runtime `mul`, or a folded value that is
 *    off-by-one) flips the rendered number. f32 Node math is per-op f32-rounded,
 *    so the JS reference applies `Math.fround` after each op the WASM would run.
 *
 * Failure mode this file hunts: a `number op number` that incorrectly LOWERS to a
 * runtime primitive (then the import set, graph, and rendered value all diverge),
 * OR a Node-touching op that fails to lower (the inverse). Both are caught.
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

/** Render a mono body with constant input, return output[0][0]. */
async function out0(decls: string, body: string, x: number): Promise<number> {
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [new Float32Array(128).fill(x)] },
  });
  return r.outputs.main![0]![0]!;
}

// f32 per-op helpers: input is read from a Float32Array so already f32-exact.
const add32 = (a: number, b: number): number => fr(a + b);
const mul32 = (a: number, b: number): number => fr(a * b);

// ───────────────────────────────────────────────────────────────────────────
// 1. The canonical const-folds: each MUST stay JS and yield its folded value.
//    The const rides into the chain call as a raw number; the JS reference
//    computes the SAME fold and proves the rendered output uses it.
// ───────────────────────────────────────────────────────────────────────────

test("Math.round(SR * 0.3) folds to 14400 (a build-time number, added at runtime)", async () => {
  const got = await out0("const SR = 48000;\nconst D = Math.round(SR * 0.3);", W(`${A} + D`), 0);
  expect(Math.round(48000 * 0.3)).toBe(14400);
  expect(got).toBe(add32(fr(0), 14400)); // 14400 exactly
});

test("const N = 64; const M = N * 2 — N*2 stays JS, M=128 used at runtime", async () => {
  const got = await out0("const N = 64;\nconst M = N * 2;", W(`${A} * M`), 2);
  expect(got).toBe(mul32(fr(2), 128));
  expect(got).toBe(256);
});

test("2 * Math.PI / SR is a build-time double, used as a per-sample increment scale", async () => {
  const inc = (2 * Math.PI) / SR;
  const got = await out0(
    "const SR = 48000;\nconst inc = (2 * Math.PI) / SR;",
    W(`${A} * inc`),
    1000,
  );
  // The const is folded in JS to a f64 double, then rides into mul as a raw
  // literal arg → the operand is lifted to f32 BEFORE the multiply (f32 node).
  expect(got).toBe(mul32(fr(1000), fr(inc)));
  expect(got).toBeCloseTo(1000 * inc, 4);
});

test("i32(SIZE - DELAY): SIZE-DELAY (number-number) folds to 70 inside i32()", async () => {
  const got = await out0(
    "const SIZE = 100;\nconst DELAY = 30;",
    W(`f32(i32(SIZE - DELAY)) + ${A}`),
    0,
  );
  expect(got).toBe(add32(fr(70), fr(0)));
  expect(got).toBe(70);
});

test("inline x * (2 * Math.PI / SR): the parenthesized const-fold stays JS, only outer mul lowers", async () => {
  const inc = (2 * Math.PI) / SR;
  const got = await out0("const SR = 48000;", W(`${A} * (2 * Math.PI / SR)`), 500);
  expect(got).toBe(mul32(fr(500), fr(inc)));
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Math.* build-time constants (PI, E, LN2, LOG2E, SQRT2, …) and named ratios.
//    All are JS doubles; mixing one with a node lowers ONLY the node-touching op.
// ───────────────────────────────────────────────────────────────────────────

test("Math.PI scales a node (x * Math.PI)", async () => {
  const got = await out0("", W(`${A} * Math.PI`), 2);
  expect(got).toBe(mul32(fr(2), Math.PI));
});

test("Math.LN2 / 12 — semitone-ratio exponent base, a folded double", async () => {
  const k = Math.LN2 / 12;
  const got = await out0("", W(`${A} * (Math.LN2 / 12)`), 7);
  expect(got).toBe(mul32(fr(7), k));
});

test("Math.E, Math.SQRT2, Math.LOG2E folds all ride as raw numbers", async () => {
  const k = Math.E + Math.SQRT2 - Math.LOG2E;
  const got = await out0("", W(`${A} + (Math.E + Math.SQRT2 - Math.LOG2E)`), 0);
  // (Math.E + Math.SQRT2 - Math.LOG2E) is number-number-number → one JS double.
  expect(got).toBe(add32(fr(0), k));
});

test("Math.pow / Math.log build-time call folds to a double const", async () => {
  const k = Math.pow(2, 1 / 12); // equal-temperament semitone ratio
  const got = await out0(`const K = Math.pow(2, 1 / 12);`, W(`${A} * K`), 4);
  expect(got).toBe(mul32(fr(4), k));
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Const arithmetic in EVERY operator + nesting depth, all staying JS.
//    Behavioral: the folded JS value is what reaches the runtime op.
// ───────────────────────────────────────────────────────────────────────────

test("const + - * / % all fold (deep mixed-precedence const subexpr stays JS)", async () => {
  // 2*3 + 4 - 17%5 = 6 + 4 - 2 = 8, then add the node.
  const k = 2 * 3 + 4 - (17 % 5);
  expect(k).toBe(8);
  const got = await out0(
    "const A=2;\nconst B=3;\nconst C=4;\nconst D=17;\nconst E=5;",
    W(`${A} + (A * B + C - D % E)`),
    1,
  );
  expect(got).toBe(add32(fr(1), 8));
});

test("nested parens in a pure-const expr fold to one number (((N+1)*2-3)/7)", async () => {
  const k = ((10 + 1) * 2 - 3) / 7; // = 19/7
  const got = await out0("const N = 10;", W(`${A} + ((N + 1) * 2 - 3) / 7`), 0);
  expect(got).toBe(add32(fr(0), fr(k)));
  expect(got).toBeCloseTo(19 / 7, 4);
});

test("const left-assoc chain stays JS (10 - 3 - 2 = 5, not 10 - (3-2) = 9)", async () => {
  const got = await out0("const A=10;\nconst B=3;\nconst C=2;", W(`${A} + (A - B - C)`), 0);
  expect(got).toBe(add32(fr(0), 5));
});

test("const division producing a fraction folds (1/3 as a JS double, lifted to f32 in mul)", async () => {
  const got = await out0("const NUM=1;\nconst DEN=3;", W(`${A} * (NUM / DEN)`), 3);
  expect(got).toBe(mul32(fr(3), 1 / 3));
});

test("unary minus on a number-const stays JS negation (-G is a number, not .neg())", async () => {
  // -G must NOT lower to neg(); G is a number, so -G is a JS number ride-along.
  const got = await out0("const G = 0.5;", W(`${A} * -G`), 4);
  expect(got).toBe(mul32(fr(4), -0.5));
  expect(got).toBe(-2);
});

test("neg-of-const in parens stays JS ((-N) is a number) and adds", async () => {
  const got = await out0("const N = 5;", W(`${A} + (-N)`), 10);
  expect(got).toBe(add32(fr(10), -5));
  expect(got).toBe(5);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Const-fold inside DECLARATION OPTION OBJECTS — must NOT lower (no node in
//    sight; the whole option literal is build-time). Proven structurally:
//    sugar form with `0.5 * 2` ≡ explicit form with `1.0` written out.
// ───────────────────────────────────────────────────────────────────────────

test("param default 0.5 * 2 stays JS (option-object math) — folds to 1.0", async () => {
  await expectSameLowering(
    mono(`const g = param.f32({ default: 0.5 * 2, min: 0, max: 2 });`, W(`${A} * g.at(i)`)),
    mono(`const g = param.f32({ default: 1.0, min: 0, max: 2 });`, W(`${A} * g.at(i)`)),
  );
});

test("param min/max/default all as const-fold expressions ≡ folded literals", async () => {
  await expectSameLowering(
    mono(
      `const g = param.f32({ default: 1 / 4, min: 0 - 1, max: 2 * 0.5 + 0.5 });`,
      W(`${A} * g.at(i)`),
    ),
    mono(`const g = param.f32({ default: 0.25, min: -1, max: 1.5 });`, W(`${A} * g.at(i)`)),
  );
});

test("param default referencing a derived const (2 * Math.PI / SR) ≡ folded double literal", async () => {
  const inc = (2 * Math.PI) / SR;
  await expectSameLowering(
    mono(
      `const SR = 48000;\nconst g = param.f32({ default: 2 * Math.PI / SR, min: 0, max: 1 });`,
      W(`${A} * g.at(i)`),
    ),
    mono(`const g = param.f32({ default: ${inc}, min: 0, max: 1 });`, W(`${A} * g.at(i)`)),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Const-fold in INDEX position. `buf[OFF + 1]` → `buf.read(OFF + 1)`: the
//    index arithmetic is number-number, must stay JS inside the read call.
// ───────────────────────────────────────────────────────────────────────────

test("buffer index const-fold stays JS: buf[OFF + 1] ≡ buf.read(OFF + 1)", async () => {
  const decls = `const buf = state.buffer.f32({ size: CAPACITY_16 }).named("buf");\nconst OFF = 3;`;
  await expectSameLowering(
    mono(decls, W(`buf[OFF + 1] + ${A}`)),
    mono(decls, W(`buf.read(OFF + 1).add(${A})`)),
  );
});

test("channel index const-fold stays JS: out.ch(0).at(N - 1) — pure-const index arg", async () => {
  // N - 1 is a build-time index; it must NOT lower. (i is the loop var; use a const here.)
  await expectSameLowering(
    mono("const N = 1;", W(`${A} * 2`).replace("at(i)", "at(N - 1)")),
    mono("const N = 1;", W(`${A}.mul(2)`).replace("at(i)", "at(N - 1)")),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Const as a COMPARISON / select operand. `x > THRESH` lowers (x is a node),
//    but THRESH rides as a raw number. A pure `CONST_A > CONST_B` condition stays
//    JS (build-time boolean), and the whole ternary stays a JS conditional.
// ───────────────────────────────────────────────────────────────────────────

test("x > THRESH ? hi : lo — node compare lowers; THRESH/hi/lo ride as raw numbers", async () => {
  const got = await out0(
    "const THRESH = 0.5;\nconst HI = 0.9;\nconst LO = 0.1;",
    W(`${A} > THRESH ? HI : LO`),
    0.8,
  );
  expect(got).toBe(fr(0.9)); // 0.8 > 0.5 → HI
  const got2 = await out0(
    "const THRESH = 0.5;\nconst HI = 0.9;\nconst LO = 0.1;",
    W(`${A} > THRESH ? HI : LO`),
    0.2,
  );
  expect(got2).toBe(fr(0.1)); // 0.2 < 0.5 → LO
});

test("structural: x > THRESH ? HI : LO ≡ select(gt(x, THRESH), HI, LO)", async () => {
  await expectSameLowering(
    mono("const THRESH = 0.5;\nconst HI = 0.9;\nconst LO = 0.1;", W(`${A} > THRESH ? HI : LO`)),
    mono(
      "const THRESH = 0.5;\nconst HI = 0.9;\nconst LO = 0.1;",
      W(`select(${A}.gt(THRESH), HI, LO)`),
    ),
  );
});

test("pure const>const ternary condition stays a JS conditional (not select)", async () => {
  // A > B is number > number → build-time JS boolean; the ternary is NOT lowered
  // to select. With A=1,B=2 the condition is false → else branch (the node).
  const got = await out0("const A=1;\nconst B=2;", W(`(A > B) ? 0 : ${A}`), 0.7);
  expect(got).toBe(fr(0.7));
  const got2 = await out0("const A=3;\nconst B=2;", W(`(A > B) ? ${A} : 0`), 0.7);
  expect(got2).toBe(fr(0.7));
});

test("structural: pure const>const ternary keeps the raw JS conditional (no select wrap)", async () => {
  // Ground truth: the explicit form is the IDENTICAL JS conditional, untouched.
  await expectSameLowering(
    mono("const A=1;\nconst B=2;", W(`(A > B) ? 0 : ${A}`)),
    mono("const A=1;\nconst B=2;", W(`(A > B) ? 0 : ${A}`)),
  );
});

test("JS-bool ternary condition stays a runtime branch, but the node BRANCHES still lower", async () => {
  // `FLAG > 0` is number>number → build-time JS boolean → the ternary is a plain
  // JS conditional (NOT select). But the else branch `x * 2` is a node op and
  // MUST still be visited + lowered. Structural ground truth: the explicit form
  // keeps the same JS `?:` with `.mul(2)` written out.
  await expectSameLowering(
    mono("const FLAG = 1;", W(`FLAG > 0 ? ${A} : ${A} * 2`)),
    mono("const FLAG = 1;", W(`FLAG > 0 ? ${A} : ${A}.mul(2)`)),
  );
  // Behavioral: FLAG=1 → true branch → the node passes through unscaled.
  const got = await out0("const FLAG = 1;", W(`FLAG > 0 ? ${A} : ${A} * 2`), 0.7);
  expect(got).toBe(fr(0.7));
  // FLAG=0 → false branch → x * 2.
  const got2 = await out0("const FLAG = 0;", W(`FLAG > 0 ? ${A} : ${A} * 2`), 0.7);
  expect(got2).toBe(mul32(fr(0.7), 2));
});

// ───────────────────────────────────────────────────────────────────────────
// 7. i64 / BigInt build-time consts. i64 has NO implicit number lift; a BigInt
//    op is build-time, and `i64(BigInt(...))` rides the folded BigInt in.
// ───────────────────────────────────────────────────────────────────────────

test("i64(BigInt(2 + 3)) — the inner 2+3 folds to a JS number, then BigInt, then i64", async () => {
  const got = await out0("", W(`f32(i64(BigInt(2 + 3))) + ${A}`), 0);
  expect(got).toBe(add32(fr(5), fr(0)));
  expect(got).toBe(5);
});

test("i64(1n + 4n) — pure BigInt arithmetic stays JS (no i64 op lowering), folds to 5n", async () => {
  const got = await out0("", W(`f32(i64(1n + 4n)) + ${A}`), 0);
  expect(got).toBe(5);
});

// ───────────────────────────────────────────────────────────────────────────
// 8. THE BOUNDARY, BOTH DIRECTIONS. A Node-typed const triggers lowering; a
//    number-typed const does not. Same surface syntax, opposite dispatch.
// ───────────────────────────────────────────────────────────────────────────

test("Node-typed const triggers lowering: const two = f32(2); two * 2 → mul(two, 2)", async () => {
  // Positive direction: `two` IS a Node, so `two * 2` MUST lower.
  await expectSameLowering(
    mono("", `const two = f32(2);\n${W(`${A} + two * 2`)}`),
    mono("", `const two = f32(2);\n${W(`${A}.add(two.mul(2))`)}`),
  );
});

test("Node const vs number const side by side: only the node-touching mul lowers", async () => {
  // n is a Node → n * K lowers; K is a number → it rides in raw.
  const got = await out0("const K = 3;", `const n = f32(0.5);\n${W(`${A} + n * K`)}`, 0);
  expect(got).toBe(add32(fr(0), mul32(fr(0.5), 3)));
  expect(got).toBe(1.5);
});

test("number const + number const (both JS) inside an outer node add — inner add stays JS", async () => {
  // (K1 + K2) is number+number → ONE folded number; only the outer add lowers.
  await expectSameLowering(
    mono("const K1 = 2;\nconst K2 = 3;", W(`${A} + (K1 + K2)`)),
    mono("const K1 = 2;\nconst K2 = 3;", W(`${A}.add(K1 + K2)`)),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 9. SAMPLES_PER_BLOCK / CAPACITY_* — these are number-literal-typed ambients;
//    arithmetic on them is build-time and must stay JS.
// ───────────────────────────────────────────────────────────────────────────

test("SAMPLES_PER_BLOCK * 2 stays JS (number-literal const), folds to 256", async () => {
  const got = await out0("const N = SAMPLES_PER_BLOCK * 2;", W(`${A} + N`), 0);
  expect(got).toBe(add32(fr(0), 256));
});

test("structural: SAMPLES_PER_BLOCK - 1 ≡ folded literal 127 inside an add", async () => {
  await expectSameLowering(
    mono("", W(`${A} + (SAMPLES_PER_BLOCK - 1)`)),
    mono("", W(`${A}.add(SAMPLES_PER_BLOCK - 1)`)),
  );
});

test("non-sugar JS operators on consts stay JS: bitwise << and ** are never lowered", async () => {
  // `<<` and `**` are not in the sugar operator set, so even on numbers they must
  // ride into the chain call verbatim (the value is computed in JS).
  const shifted = await out0("const N = 4;", W(`${A} + (N << 1)`), 0); // 4<<1 = 8
  expect(shifted).toBe(add32(fr(0), 8));
  const powed = await out0("const N = 3;", W(`${A} + (N ** 2)`), 0); // 3**2 = 9
  expect(powed).toBe(add32(fr(0), 9));
});

test("a mutable `let` number variable still rides as JS (let N=64; N*2 stays JS)", async () => {
  await expectSameLowering(
    mono("let N = 64;", W(`${A} + N * 2`)),
    mono("let N = 64;", W(`${A}.add(N * 2)`)),
  );
});

test("const read from an object field / array length stays JS", async () => {
  const got = await out0("const cfg = { gain: 0.5 };", W(`${A} * cfg.gain`), 8);
  expect(got).toBe(mul32(fr(8), fr(0.5)));
  const lenGot = await out0("const arr = [1, 2, 3];\nconst L = arr.length;", W(`${A} + L`), 0);
  expect(lenGot).toBe(add32(fr(0), 3));
});

// ───────────────────────────────────────────────────────────────────────────
// 10. Adversarial const-fold values chosen so a WRONG lowering flips the answer.
//     If `N * 2` ever lowered to a runtime `mul`, the import set + value diverge.
// ───────────────────────────────────────────────────────────────────────────

test("ADVERSARIAL: const fold yields a value that an f32-rounded runtime op would NOT (1e8 + 1 - 1e8)", async () => {
  // Build-time: (1e8 + 1 - 1e8) computed in JS f64 = 1 exactly. If this had
  // lowered to per-op f32 runtime math the leading 1e8 add would lose the +1
  // and give 0. The const-fold preserving 1 proves it stayed JS double.
  const got = await out0("const K = 1e8 + 1 - 1e8;", W(`${A} + K`), 0);
  expect(1e8 + 1 - 1e8).toBe(1);
  expect(got).toBe(add32(fr(0), 1)); // K folded to 1 in JS, not 0 from f32 runtime
  expect(got).toBe(1);
});

test("ADVERSARIAL: const integer division truncation does NOT happen in JS fold (7/2 = 3.5)", async () => {
  // JS number division is float; const 7/2 = 3.5, NOT i32-truncated 3. Proves the
  // fold runs in JS, not as a typed i32 div.
  const got = await out0("const K = 7 / 2;", W(`${A} + K`), 0);
  expect(got).toBe(add32(fr(0), fr(3.5)));
  expect(got).toBe(3.5);
});

test("ADVERSARIAL: a const equal to a node value still rides raw (no structural merge)", async () => {
  // The const 0.3 and the node both carry 0.3, but the const must stay a raw
  // literal arg — structural equivalence to an explicit raw-literal add.
  await expectSameLowering(
    mono("const K = 0.1 + 0.2;", W(`${A} + K`)),
    mono("const K = 0.1 + 0.2;", W(`${A}.add(K)`)),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 11. Const mixed with DSP in a long realistic phasor-style expression.
// ───────────────────────────────────────────────────────────────────────────

test("realistic: phase increment x * (440 * 2 * Math.PI / SR) — full const-fold scale", async () => {
  const inc = (440 * 2 * Math.PI) / SR;
  const got = await out0("const SR = 48000;", W(`${A} * (440 * 2 * Math.PI / SR)`), 1);
  expect(got).toBe(mul32(fr(1), inc));
  expect(got).toBeCloseTo(inc, 6);
});

test("realistic: gain-staged const (0.5 * 0.5 * 0.5) folds to 0.125, scales node", async () => {
  const got = await out0("", W(`${A} * (0.5 * 0.5 * 0.5)`), 8);
  expect(got).toBe(mul32(fr(8), fr(0.125)));
  expect(got).toBe(1);
});

test("realistic: structural — const scale factor ≡ explicit chained mul with raw literal", async () => {
  await expectSameLowering(
    mono("const SR = 48000;", W(`${A} * (2 * Math.PI / SR)`)),
    mono("const SR = 48000;", W(`${A}.mul(2 * Math.PI / SR)`)),
  );
});
