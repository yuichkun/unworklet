/**
 * Comparison-operator sugar (`==` `!=` `<` `>` `<=` `>=`, incl. strict `===`/`!==`)
 * → `Node<"bool">`, consumed by `select` / ternary / `if`.
 *
 * Two oracles:
 * - `expectSameLowering(sugar, explicit)` — the `explicit` is hand-written CHAIN DSL
 *   (no operator/index/bare-state/if sugar), the GROUND TRUTH. Correct sugar matches.
 * - `renderLowered(uwk, config)` — lower + eval + render, checked against a pure-JS
 *   reference. Most robust for semantic claims (threshold crossing, int vs float,
 *   precedence, literal-lift type).
 *
 * Lowering contract (comparison subset):
 *   a == b → eq(a,b)     a === b → eq(a,b)
 *   a != b → not(eq(a,b))  a !== b → not(eq(a,b))
 *   a <  b → lt(a,b)     a >  b → gt(a,b)
 *   a <= b → lte(a,b)    a >= b → gte(a,b)
 * TYPE-DIRECTED: lowers iff an operand is / becomes a Node or State. A bare State
 * operand reads (`s` → `s.read()`). `number op number` stays build-time JS.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, lower, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const DUR = 128 / SR;

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

/** Render a mono `.uwk.ts`, return the first channel as a plain number[]. */
async function render1(uwk: string, input: Float32Array): Promise<number[]> {
  const r = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [input] },
  });
  return Array.from(r.outputs.main![0]!);
}

/** An input ramp that straddles every interesting comparison threshold. */
const PROBE = Float32Array.from([
  -1, -0.5, -0.00001, 0, 0.00001, 0.25, 0.49999, 0.5, 0.50001, 0.9, 1, 2,
]);
// pad to a full block so renderOffline has 128 samples; only first 12 matter
function padded(head: number[]): Float32Array {
  const a = new Float32Array(128);
  for (let n = 0; n < head.length; n++) a[n] = head[n]!;
  return a;
}
const PROBE128 = padded(Array.from(PROBE));

// ─────────────────────────────────────────────────────────────────────────
// 1. Structural: each operator lowers to its exact chain primitive (ground truth)
// ─────────────────────────────────────────────────────────────────────────

test("== lowers to eq", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) == 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(eq(input.ch(0).at(i), 0.5), 1, 0));`),
  );
});

test("=== (strict) lowers to eq, same as ==", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) === 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(eq(input.ch(0).at(i), 0.5), 1, 0));`),
  );
});

test("!= lowers to not(eq(...))", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) != 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(not(eq(input.ch(0).at(i), 0.5)), 1, 0));`),
  );
});

test("!== (strict) lowers to not(eq(...)), same as !=", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) !== 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(not(eq(input.ch(0).at(i), 0.5)), 1, 0));`),
  );
});

test("< lowers to lt", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) < 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(lt(input.ch(0).at(i), 0.5), 1, 0));`),
  );
});

test("> lowers to gt", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) > 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(gt(input.ch(0).at(i), 0.5), 1, 0));`),
  );
});

test("<= lowers to lte", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) <= 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(lte(input.ch(0).at(i), 0.5), 1, 0));`),
  );
});

test(">= lowers to gte", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) >= 0.5, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(gte(input.ch(0).at(i), 0.5), 1, 0));`),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Structural: operand orientation, bare-state reads, both-state
// ─────────────────────────────────────────────────────────────────────────

test("number on the LEFT: 0.5 < node → lt(0.5, node) (NOT flipped)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(0.5 < input.ch(0).at(i), 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(lt(0.5, input.ch(0).at(i)), 1, 0));`),
  );
});

test("number on the LEFT for >=: 0.5 >= node → gte(0.5, node)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(0.5 >= input.ch(0).at(i), 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(gte(0.5, input.ch(0).at(i)), 1, 0));`),
  );
});

test("bare State on the LEFT reads: s < 1 → lt(s.read(), 1)", async () => {
  const decls = "const s = state.f32(0).named('s');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(select(s < 1, 1, 0));`),
    mono(decls, `out.ch(0).at(i).write(select(lt(s.read(), 1), 1, 0));`),
  );
});

test("bare State on BOTH sides reads both: s < t → lt(s.read(), t.read())", async () => {
  const decls = "const s = state.f32(0).named('s');\nconst t = state.f32(1).named('t');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(select(s < t, 1, 0));`),
    mono(decls, `out.ch(0).at(i).write(select(lt(s.read(), t.read()), 1, 0));`),
  );
});

test("bare State on the right, node on the left: node == s → eq(node, s.read())", async () => {
  const decls = "const s = state.f32(0).named('s');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(select(input.ch(0).at(i) == s, 1, 0));`),
    mono(decls, `out.ch(0).at(i).write(select(eq(input.ch(0).at(i), s.read()), 1, 0));`),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Structural: composition with arithmetic (precedence), if-sugar, nesting
// ─────────────────────────────────────────────────────────────────────────

test("arithmetic operands lower under the comparison: x*2+1 > 3", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) * 2 + 1 > 3, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(gt(add(mul(input.ch(0).at(i), 2), 1), 3), 1, 0));`),
  );
});

test("comparison precedence vs arithmetic: a < b + c parses as a < (b + c)", async () => {
  // > binds looser than +, so `x < 1 + 1` is `x < (1+1)`. The 1+1 stays JS (both numbers).
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) < 1 + 1, 1, 0));`),
    mono("", `out.ch(0).at(i).write(select(lt(input.ch(0).at(i), 1 + 1), 1, 0));`),
  );
});

test("comparison result fed into arithmetic: (x>0?1:0)*2", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write((input.ch(0).at(i) > 0 ? 1 : 0) * 2);`),
    mono("", `out.ch(0).at(i).write(mul(select(gt(input.ch(0).at(i), 0), 1, 0), 2));`),
  );
});

test("if-sugar uses the comparison as select condition", async () => {
  const decls = "const peak = state.f32(0).named('peak');";
  await expectSameLowering(
    mono(
      decls,
      `const x = input.ch(0).at(i);\nif (x > peak.read()) peak.write(x);\nout.ch(0).at(i).write(peak.read());`,
    ),
    mono(
      decls,
      `const x = input.ch(0).at(i);\npeak.write(select(gt(x, peak.read()), x, peak.read()));\nout.ch(0).at(i).write(peak.read());`,
    ),
  );
});

test("if-else sugar with comparison: symmetric write → single select", async () => {
  const decls = "const held = state.f32(0).named('held');";
  await expectSameLowering(
    mono(
      decls,
      `const x = input.ch(0).at(i);\nif (x >= 0) held.write(x); else held.write(x.neg());\nout.ch(0).at(i).write(held.read());`,
    ),
    mono(
      decls,
      `const x = input.ch(0).at(i);\nheld.write(select(gte(x, 0), x, x.neg()));\nout.ch(0).at(i).write(held.read());`,
    ),
  );
});

test("nested ternary with two comparisons (clamp to band)", async () => {
  await expectSameLowering(
    mono("", `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(x < 0 ? 0 : (x > 1 ? 1 : x));`),
    mono(
      "",
      `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(select(lt(x, 0), 0, select(gt(x, 1), 1, x)));`,
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Build-time: number op number stays JS (must NOT lower)
// ─────────────────────────────────────────────────────────────────────────

test("const number == number stays build-time JS (NOT lowered)", async () => {
  // `1 == 1` is a JS boolean, used as a build-time ternary; only the DSP branch survives.
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(1 == 1 ? input.ch(0).at(i) : input.ch(0).at(i).neg());`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i));`),
  );
});

test("const < const stays build-time JS, selects branch at lower-time", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(2 < 1 ? input.ch(0).at(i) : input.ch(0).at(i).neg());`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).neg());`),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 5. BEHAVIORAL: threshold crossing — the JS reference is ground truth
// ─────────────────────────────────────────────────────────────────────────

test("behavioral: x > 0.5 emits 1 above, 0 at/below (strict)", async () => {
  const got = await render1(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) > 0.5 ? 1 : 0);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    expect(got[n]).toBeCloseTo(PROBE[n]! > 0.5 ? 1 : 0, 5);
  }
});

test("behavioral: x >= 0.5 includes equality (0.5 → 1)", async () => {
  const got = await render1(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) >= 0.5 ? 1 : 0);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    expect(got[n]).toBeCloseTo(PROBE[n]! >= 0.5 ? 1 : 0, 5);
  }
  // pin the exact-equality sample (index 7 is 0.5)
  expect(got[7]).toBeCloseTo(1, 5);
});

test("behavioral: x < 0.5 vs x <= 0.5 differ exactly at 0.5", async () => {
  const lt = await render1(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) < 0.5 ? 1 : 0);`),
    PROBE128,
  );
  const lte = await render1(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) <= 0.5 ? 1 : 0);`),
    PROBE128,
  );
  expect(lt[7]).toBeCloseTo(0, 5); // 0.5 < 0.5 is false
  expect(lte[7]).toBeCloseTo(1, 5); // 0.5 <= 0.5 is true
});

test("behavioral: x == 0.5 is exact (only the 0.5 sample, off-by-epsilon are 0)", async () => {
  const got = await render1(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) == 0.5 ? 1 : 0);`),
    PROBE128,
  );
  // 0.5 is exactly representable in f32, so the literal compares true only there.
  for (let n = 0; n < PROBE.length; n++) {
    expect(got[n]).toBeCloseTo(PROBE[n] === 0.5 ? 1 : 0, 5);
  }
});

test("behavioral: x != 0.5 is the complement of ==", async () => {
  const got = await render1(
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i) != 0.5 ? 1 : 0);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    expect(got[n]).toBeCloseTo(PROBE[n] === 0.5 ? 0 : 1, 5);
  }
});

test("behavioral: reversed operands 0.5 < x equals x > 0.5", async () => {
  const rev = await render1(
    mono("", `out.ch(0).at(i).write(0.5 < input.ch(0).at(i) ? 1 : 0);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    expect(rev[n]).toBeCloseTo(PROBE[n]! > 0.5 ? 1 : 0, 5);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 6. BEHAVIORAL: integer comparison (i32 state) — exact equality, signed compare
// ─────────────────────────────────────────────────────────────────────────

test("behavioral: i32 state == literal, ramps a counter and matches at exact value", async () => {
  // counter increments each sample 0,1,2,...; emit 1 when counter == 3.
  const decls = "const k = state.i32(0).named('k');";
  const body = `out.ch(0).at(i).write(k == 3 ? 1 : 0);\nk.write(k.read() + 1);`;
  const got = await render1(mono(decls, body), new Float32Array(128));
  for (let n = 0; n < 8; n++) {
    expect(got[n]).toBeCloseTo(n === 3 ? 1 : 0, 5);
  }
});

test("behavioral: i32 signed less-than handles negatives correctly", async () => {
  // counter goes -3,-2,...; emit 1 while counter < 0.
  const decls = "const k = state.i32(-3).named('k');";
  const body = `out.ch(0).at(i).write(k < 0 ? 1 : 0);\nk.write(k.read() + 1);`;
  const got = await render1(mono(decls, body), new Float32Array(128));
  // counter: -3,-2,-1,0,1,2,... → <0 true for first 3 samples
  for (let n = 0; n < 8; n++) {
    expect(got[n]).toBeCloseTo(n < 3 ? 1 : 0, 5);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 7. BEHAVIORAL: comparison feeding arithmetic — bool acts as 0/1 in select
// ─────────────────────────────────────────────────────────────────────────

test("behavioral: (x > 0 ? 1 : 0) * 3 yields 3 above 0, 0 at/below", async () => {
  const got = await render1(
    mono("", `out.ch(0).at(i).write((input.ch(0).at(i) > 0 ? 1 : 0) * 3);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    expect(got[n]).toBeCloseTo(PROBE[n]! > 0 ? 3 : 0, 5);
  }
});

test("behavioral: select passes through a value branch, not a constant", async () => {
  // gate: pass x through when x > 0.5, else 0 (classic noise gate)
  const got = await render1(
    mono("", `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(x > 0.5 ? x : 0);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    expect(got[n]).toBeCloseTo(PROBE[n]! > 0.5 ? PROBE[n]! : 0, 5);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 8. ADVERSARIAL: deep nesting, chained compare, mixed with bare state
// ─────────────────────────────────────────────────────────────────────────

test("adversarial: band-pass gate x>lo && via nested ternary matches JS", async () => {
  // emit x when 0.25 < x < 0.75 else 0, expressed as nested ternary
  const got = await render1(
    mono(
      "",
      `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(x > 0.25 ? (x < 0.75 ? x : 0) : 0);`,
    ),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    const x = PROBE[n]!;
    expect(got[n]).toBeCloseTo(x > 0.25 && x < 0.75 ? x : 0, 5);
  }
});

test("adversarial: comparison both operands arithmetic on the same input", async () => {
  // x*2 > x+0.5  ⇔  x > 0.5
  const got = await render1(
    mono("", `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(x * 2 > x + 0.5 ? 1 : 0);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    const x = PROBE[n]!;
    expect(got[n]).toBeCloseTo(x * 2 > x + 0.5 ? 1 : 0, 4);
  }
});

test("adversarial: negation inside comparison: -x < 0 ⇔ x > 0", async () => {
  const got = await render1(
    mono("", `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(-x < 0 ? 1 : 0);`),
    PROBE128,
  );
  for (let n = 0; n < PROBE.length; n++) {
    const x = PROBE[n]!;
    expect(got[n]).toBeCloseTo(-x < 0 ? 1 : 0, 5);
  }
});

test("adversarial: structural — -x < 0 lowers to lt(neg(x), 0)", async () => {
  await expectSameLowering(
    mono("", `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(select(-x < 0, 1, 0));`),
    mono("", `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(select(lt(neg(x), 0), 1, 0));`),
  );
});

test("adversarial: chained compare (a < b) < c lowers as lt(lt(...), c)", async () => {
  // JS would parse `a < b < c` as `(a < b) < c`. The inner bool feeds lt with a number.
  const sugar = mono("", `out.ch(0).at(i).write(select((input.ch(0).at(i) < 0.5) < 1, 1, 0));`);
  const explicit = mono(
    "",
    `out.ch(0).at(i).write(select(lt(lt(input.ch(0).at(i), 0.5), 1), 1, 0));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("adversarial: comparison with arithmetic on BOTH operands of the same input", async () => {
  // structural: x*2 > x+0.5 lowers to gt(mul(x,2), add(x,0.5))
  await expectSameLowering(
    mono("", `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(select(x * 2 > x + 0.5, 1, 0));`),
    mono(
      "",
      `const x = input.ch(0).at(i);\nout.ch(0).at(i).write(select(gt(mul(x, 2), add(x, 0.5)), 1, 0));`,
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 9. i32 comparison: sugar is FAITHFUL to the explicit chain (incl. the core
//    integer literal-lift behavior — the sugar pass does not add or hide it)
// ─────────────────────────────────────────────────────────────────────────

test("i32 state == integer literal: sugar ≡ eq(k.read(), n)", async () => {
  const decls = "const k = state.i32(0).named('k');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(select(k == 3, 1, 0));`),
    mono(decls, `out.ch(0).at(i).write(select(eq(k.read(), 3), 1, 0));`),
  );
});

test("i32 state < integer literal: sugar ≡ lt(k.read(), n) — operand order kept", async () => {
  const decls = "const k = state.i32(0).named('k');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(select(k < 2, 1, 0));`),
    mono(decls, `out.ch(0).at(i).write(select(lt(k.read(), 2), 1, 0));`),
  );
});

test("behavioral: i32 counter == 3 fires exactly once at the matching index", async () => {
  const decls = "const k = state.i32(0).named('k');";
  const body = `out.ch(0).at(i).write(k == 3 ? 1 : 0);\nk.write(k.read() + 1);`;
  const got = await render1(mono(decls, body), new Float32Array(128));
  // exactly one 1 in the whole block, at index 3
  const ones = got.map((v, idx) => (Math.round(v) === 1 ? idx : -1)).filter((idx) => idx >= 0);
  expect(ones).toEqual([3]);
});

test("behavioral: i32 counter >= 4 latches on at the boundary and stays on", async () => {
  const decls = "const k = state.i32(0).named('k');";
  const body = `out.ch(0).at(i).write(k >= 4 ? 1 : 0);\nk.write(k.read() + 1);`;
  const got = await render1(mono(decls, body), new Float32Array(128));
  for (let n = 0; n < 12; n++) expect(got[n]).toBeCloseTo(n >= 4 ? 1 : 0, 5);
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Debug helper sanity: lower() is callable for diagnostics
// ─────────────────────────────────────────────────────────────────────────

test("debug: lower() yields not(eq(...)) text for !=", () => {
  const text = lower(mono("", `out.ch(0).at(i).write(select(input.ch(0).at(i) != 0.5, 1, 0));`));
  expect(text).toContain("not(eq(");
});
