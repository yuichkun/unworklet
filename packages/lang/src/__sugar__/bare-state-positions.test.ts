/**
 * EXHAUSTIVE bit-identity + behavioral tests for BARE-STATE positioning sugar.
 *
 * A bare `State<T>` reference used in a `Node<T>` value position auto-reads:
 * `gain` → `gain.read()`. The handle stays a handle in WRITE-TARGET / declaration /
 * `.named` / `.expose` chains and in a `State`-typed L1-helper / subgraph parameter.
 * The handle-vs-value disambiguation (driven by the contextual type printing a
 * `Node<` brand) is the bug surface this file hunts.
 *
 * Two oracles (see `../goldenHarness.ts`):
 *  - `expectSameLowering(sugar, explicit)` — the `explicit` form is hand-written
 *    chain DSL (every read is written `s.read()` by hand). GROUND TRUTH; catches
 *    structural drift in where the read-wrap is (or isn't) inserted.
 *  - `renderLowered(uwk, config)` — lower + eval + render, compared to a pure-JS
 *    reference. Pins down semantics: a read returns the *current* state value, an
 *    accumulator reads the OLD value, and a read-wrapped operand computes the right
 *    number (off-by-one / read-vs-handle confusion would change the output).
 *
 * Lowering contract exercised:
 *  - bare State in a Node position → `.read()`:
 *      abs(s), sin(s), …            (unary math arg)
 *      max(s,x), min(s,x), mod(s,x) (binary math arg, either position)
 *      clamp(s,lo,hi)               (ternary math arg, any of the three)
 *      t.write(s)                   (write VALUE)
 *      buf[s], buf[s]=v, buf[i]=s   (index idx / value)
 *      in.ch(c)[s], param[s]        (index idx)
 *      out.ch(c)[i]=s               (output-channel write value)
 *      select(c, s, …)              (explicit-select branch)
 *  - bare State that STAYS a handle (no `.read()`):
 *      s.write(v)                   (write TARGET)
 *      s.named(...) / s.expose(...) (handle chains)
 *      fn(s) where fn's param is State<T> (L1-helper / subgraph handle param)
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

/** Render `out = expr(x)` for constant input `x`; return sample 0. */
async function render1(decls: string, body: string, x: number): Promise<number> {
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [block(x)] },
  });
  return r.outputs.main![0]![0]!;
}

/** Render with no input (state-only); return the whole channel-0 block. */
async function renderBlock(decls: string, body: string): Promise<Float32Array> {
  const r = await renderLowered(mono(decls, body), { sampleRate: SR, duration: DUR });
  return r.outputs.main![0]!;
}

// ─────────────────────────── unary math arg: abs(s), sin(s), … ──────────────
// A bare State in a single-arg math function reads. Structural equivalence first
// (every unary primitive), then a behavioral anchor per arity to prove the read
// returns the state value (not a handle, not zero).

const UNARY = ["abs", "sin", "cos", "tan", "tanh", "exp", "log", "sqrt", "floor", "ceil", "frac"];

for (const fn of UNARY) {
  test(`STRUCT: ${fn}(s) reads the state`, async () => {
    const d = `const s = state.f32(0.5).named("s");`;
    await expectSameLowering(
      mono(d, `out.ch(0).at(i).write(${fn}(s));`),
      mono(d, `out.ch(0).at(i).write(${fn}(s.read()));`),
    );
  });
}

test("SEMANTIC: abs(s) returns |state| — proves read, not handle", async () => {
  const got = await renderBlock(
    `const s = state.f32(-0.75).named("s");`,
    `out.ch(0).at(i).write(abs(s));`,
  );
  expect(got[0]).toBe(fr(0.75));
});

test("SEMANTIC: sqrt(s) returns sqrt(state)", async () => {
  const got = await renderBlock(
    `const s = state.f32(0.25).named("s");`,
    `out.ch(0).at(i).write(sqrt(s));`,
  );
  expect(got[0]).toBe(fr(Math.sqrt(fr(0.25))));
});

// ─────────────────────────── binary math arg: max/min/mod(s, …) ─────────────
// State in EITHER position reads; the other operand is a Node / literal.

test("STRUCT: max(s, x) reads only the state operand", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(max(s, input.ch(0).at(i)));`),
    mono(d, `out.ch(0).at(i).write(max(s.read(), input.ch(0).at(i)));`),
  );
});

test("STRUCT: min(x, s) reads the state in the 2nd position", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(min(input.ch(0).at(i), s));`),
    mono(d, `out.ch(0).at(i).write(min(input.ch(0).at(i), s.read()));`),
  );
});

test("STRUCT: max(s1, s2) reads BOTH state operands", async () => {
  const d = `const a = state.f32(0.3).named("a"); const b = state.f32(0.7).named("b");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(max(a, b));`),
    mono(d, `out.ch(0).at(i).write(max(a.read(), b.read()));`),
  );
});

test("STRUCT: mod(s, lit) reads the state", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(mod(s, 0.3));`),
    mono(d, `out.ch(0).at(i).write(mod(s.read(), 0.3));`),
  );
});

test("SEMANTIC: max(s, x) returns max(state, x)", async () => {
  const d = `const s = state.f32(0.6).named("s");`;
  expect(await render1(d, `out.ch(0).at(i).write(max(s, input.ch(0).at(i)));`, 0.2)).toBe(fr(0.6));
  expect(await render1(d, `out.ch(0).at(i).write(max(s, input.ch(0).at(i)));`, 0.9)).toBe(fr(0.9));
});

test("SEMANTIC: min(a, b) reads both — JS reference", async () => {
  const got = await renderBlock(
    `const a = state.f32(0.3).named("a"); const b = state.f32(0.7).named("b");`,
    `out.ch(0).at(i).write(min(a, b));`,
  );
  expect(got[0]).toBe(fr(Math.min(fr(0.3), fr(0.7))));
});

// ─────────────────────────── ternary math arg: clamp(s, lo, hi) ─────────────
// State in any of the three argument slots reads.

test("STRUCT: clamp(s, lo, hi) reads x-slot state", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(clamp(s, 0, 1));`),
    mono(d, `out.ch(0).at(i).write(clamp(s.read(), 0, 1));`),
  );
});

test("STRUCT: clamp(x, sLo, sHi) reads the lo/hi state slots", async () => {
  const d = `const lo = state.f32(0.2).named("lo"); const hi = state.f32(0.8).named("hi");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo, hi));`),
    mono(d, `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo.read(), hi.read()));`),
  );
});

test("STRUCT: clamp(s, sLo, sHi) reads all three", async () => {
  const d = `const x = state.f32(0.5).named("x"); const lo = state.f32(0.2).named("lo"); const hi = state.f32(0.8).named("hi");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(clamp(x, lo, hi));`),
    mono(d, `out.ch(0).at(i).write(clamp(x.read(), lo.read(), hi.read()));`),
  );
});

test("SEMANTIC: clamp(x, sLo, sHi) clamps to the state bounds", async () => {
  const d = `const lo = state.f32(0.2).named("lo"); const hi = state.f32(0.8).named("hi");`;
  expect(await render1(d, `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo, hi));`, 1.5)).toBe(
    fr(0.8),
  );
  expect(await render1(d, `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo, hi));`, -1.0)).toBe(
    fr(0.2),
  );
  expect(await render1(d, `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo, hi));`, 0.5)).toBe(
    fr(0.5),
  );
});

// ─────────────────────────── write VALUE: t.write(s) ────────────────────────
// The value passed to `.write()` is a Node position → bare State reads. The
// target `t` itself stays a handle (it is the property-access object).

test("STRUCT: t.write(s) — value reads, target stays a handle", async () => {
  const d = `const s = state.f32(0.5).named("s"); const t = state.f32(0).named("t");`;
  await expectSameLowering(
    mono(d, `t.write(s); out.ch(0).at(i).write(t.read());`),
    mono(d, `t.write(s.read()); out.ch(0).at(i).write(t.read());`),
  );
});

test("SEMANTIC: t.write(s) copies the state value through", async () => {
  const got = await renderBlock(
    `const s = state.f32(0.42).named("s"); const t = state.f32(0).named("t");`,
    `t.write(s); out.ch(0).at(i).write(t.read());`,
  );
  expect(got[0]).toBe(fr(0.42));
});

test("STRUCT: s.write(s2 + 1) — only the read operand reads, s stays target", async () => {
  const d = `const s = state.f32(0).named("s"); const s2 = state.f32(3).named("s2");`;
  await expectSameLowering(
    mono(d, `s.write(s2 + 1); out.ch(0).at(i).write(s.read());`),
    mono(d, `s.write(s2.read().add(1)); out.ch(0).at(i).write(s.read());`),
  );
});

// ─────────────────────────── index idx / value with bare state ──────────────

test("STRUCT: buf[s] read — state index reads", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf"); const s = state.i32(2).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[s]);`),
    mono(d, `out.ch(0).at(i).write(buf.read(s.read()));`),
  );
});

test("STRUCT: buf[s] = v write — state index reads", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf"); const s = state.i32(2).named("s");`;
  await expectSameLowering(
    mono(d, `buf[s] = 1; out.ch(0).at(i).write(buf.read(0));`),
    mono(d, `buf.write(s.read(), 1); out.ch(0).at(i).write(buf.read(0));`),
  );
});

test("STRUCT: buf[i] = s write — state VALUE reads, index untouched", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf"); const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `buf[i] = s; out.ch(0).at(i).write(buf.read(i));`),
    mono(d, `buf.write(i, s.read()); out.ch(0).at(i).write(buf.read(i));`),
  );
});

test("STRUCT: buf[sIdx] = sVal — both index and value read", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf"); const idx = state.i32(3).named("idx"); const v = state.f32(0.5).named("v");`;
  await expectSameLowering(
    mono(d, `buf[idx] = v; out.ch(0).at(i).write(buf.read(0));`),
    mono(d, `buf.write(idx.read(), v.read()); out.ch(0).at(i).write(buf.read(0));`),
  );
});

test("STRUCT: in.ch(c)[s] — state index into an input channel reads", async () => {
  const d = `const s = state.i32(0).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(input.ch(0)[s]);`),
    mono(d, `out.ch(0).at(i).write(input.ch(0).at(s.read()));`),
  );
});

test("STRUCT: param[s] — state index into a param reads", async () => {
  const d = `const p = param.f32({ min: 0, max: 1, default: 0.5 }).named("p"); const s = state.i32(0).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(p[s]);`),
    mono(d, `out.ch(0).at(i).write(p.at(s.read()));`),
  );
});

test("STRUCT: out.ch(c)[i] = s — output-channel write value reads", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0)[i] = s;`),
    mono(d, `out.ch(0).at(i).write(s.read());`),
  );
});

test("SEMANTIC: buf[sIdx] = sVal then read back — both reads return state values", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf"); const idx = state.i32(4).named("idx"); const v = state.f32(0.33).named("v");`;
  const got = await renderBlock(d, `buf[idx] = v; out.ch(0).at(i).write(buf.read(4));`);
  expect(got[0]).toBe(fr(0.33));
});

test("SEMANTIC: out.ch(0)[i] = s writes the state value to the output", async () => {
  const got = await renderBlock(`const s = state.f32(0.61).named("s");`, `out.ch(0)[i] = s;`);
  expect(got[0]).toBe(fr(0.61));
});

// ─────────────────────────── explicit select branch ────────────────────────
// State in a `select(cond, then, else)` branch reads (then/else are Node slots).

test("STRUCT: select(c, s1, s2) reads both branches", async () => {
  const d = `const a = state.f32(1).named("a"); const b = state.f32(-1).named("b");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(select(input.ch(0).at(i) > 0, a, b));`),
    mono(d, `out.ch(0).at(i).write(select(input.ch(0).at(i).gt(0), a.read(), b.read()));`),
  );
});

test("SEMANTIC: select(x>0, s, 0) picks the state when true", async () => {
  const d = `const s = state.f32(0.9).named("s");`;
  expect(await render1(d, `out.ch(0).at(i).write(select(input.ch(0).at(i) > 0, s, 0));`, 1)).toBe(
    fr(0.9),
  );
  expect(await render1(d, `out.ch(0).at(i).write(select(input.ch(0).at(i) > 0, s, 0));`, -1)).toBe(
    0,
  );
});

test("SEMANTIC: sugar ternary (s > 0.5) ? s : 0 reads in condition AND branch", async () => {
  const d = `const s = state.f32(0.9).named("s");`;
  const got = await renderBlock(d, `out.ch(0).at(i).write((s > 0.5) ? s : 0);`);
  expect(got[0]).toBe(fr(0.9));
});

test("STRUCT: sugar ternary (s>0.5)?s:lit lowers cond+branch reads", async () => {
  const d = `const s = state.f32(0.9).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write((s > 0.5) ? s : 0);`),
    mono(d, `out.ch(0).at(i).write(select(s.read().gt(0.5), s.read(), 0));`),
  );
});

// ─────────────────────────── NOT read: handle positions ─────────────────────
// The write target, .named / .expose chains, and a State-typed L1-helper /
// subgraph parameter all keep the bare handle (NO .read() injected).

test("STRUCT: s.write(v) — target is a handle, not read", async () => {
  const d = `const s = state.f32(0).named("s");`;
  // Ground truth literally writes the same call; if the pass wrongly read-wrapped
  // the target it would print `s.read().write(...)` and diverge.
  await expectSameLowering(
    mono(d, `s.write(input.ch(0).at(i)); out.ch(0).at(i).write(s.read());`),
    mono(d, `s.write(input.ch(0).at(i)); out.ch(0).at(i).write(s.read());`),
  );
});

test("STRUCT: s.named(...) chain keeps the handle", async () => {
  // A `.named()` rename on an otherwise-anonymous state; the object of the
  // property access must stay the bare handle.
  const sugar = mono(
    `const s = state.f32(0);`,
    `s.named("g").write(input.ch(0).at(i)); out.ch(0).at(i).write(s.read());`,
  );
  const explicit = mono(
    `const s = state.f32(0);`,
    `s.named("g").write(input.ch(0).at(i)); out.ch(0).at(i).write(s.read());`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT: L1-helper State<T> param — passing s keeps the handle", async () => {
  // `acc` is typed State<"f32"> so `inc(s, x)` passes the handle (a value position
  // would read it). The read happens INSIDE the helper via `acc.read()`.
  const d = `const inc = (acc: State<"f32">, x: Node<"f32">): Node<"f32"> => { acc.write(acc.read() + x); return acc.read(); };\nconst s = state.f32(0).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(inc(s, input.ch(0).at(i)));`),
    mono(d, `out.ch(0).at(i).write(inc(s, input.ch(0).at(i)));`),
  );
});

test("STRUCT: L1-helper Node<T> param next to a State<T> param — only the Node arg reads", async () => {
  const d = `const mix = (acc: State<"f32">, gain: Node<"f32">): Node<"f32"> => acc.read().mul(gain);\nconst s = state.f32(0).named("s"); const g = state.f32(0.5).named("g");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(mix(s, g));`),
    mono(d, `out.ch(0).at(i).write(mix(s, g.read()));`),
  );
});

test("SEMANTIC: L1-helper State<T> param accumulates correctly (handle, not snapshot)", async () => {
  // If `inc(s, …)` wrongly passed s.read() the helper would mutate a copy and the
  // accumulator would never advance.
  const d = `const inc = (acc: State<"f32">, x: Node<"f32">): Node<"f32"> => { acc.write(acc.read() + x); return acc.read(); };\nconst s = state.f32(0).named("s");`;
  const got = await renderBlock(d, `out.ch(0).at(i).write(inc(s, f32(1)));`);
  expect(got[0]).toBe(1);
  expect(got[1]).toBe(2);
  expect(got[127]).toBe(128);
});

// ─────────────────────────── accumulator / read-vs-write ordering ───────────
// The bare-state read must return the CURRENT value at the read site; an
// accumulator `s.write(s + 1)` reads the OLD value (write is the last op).

test("SEMANTIC: accumulator s.write(s + 1) emits 1,2,3,…,128", async () => {
  const got = await renderBlock(
    `const c = state.f32(0).named("c");`,
    `c.write(c + 1); out.ch(0).at(i).write(c.read());`,
  );
  expect(Array.from(got.slice(0, 5))).toEqual([1, 2, 3, 4, 5]);
  expect(got[127]).toBe(128);
});

test("SEMANTIC: read BEFORE write sees the old value — out = s; s.write(s+1)", async () => {
  const got = await renderBlock(
    `const c = state.f32(0).named("c");`,
    `out.ch(0).at(i).write(c); c.write(c + 1);`,
  );
  // sample 0 reads 0 (initial), then writes 1; sample 1 reads 1, writes 2, …
  expect(Array.from(got.slice(0, 5))).toEqual([0, 1, 2, 3, 4]);
  expect(got[127]).toBe(127);
});

// ─────────────────────────── multiple reads of the same state ───────────────

test("STRUCT: abs(s) * s — each occurrence reads independently", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(abs(s) * s);`),
    mono(d, `out.ch(0).at(i).write(abs(s.read()).mul(s.read()));`),
  );
});

test("SEMANTIC: abs(s) * s = |state| * state", async () => {
  const got = await renderBlock(
    `const s = state.f32(-0.5).named("s");`,
    `out.ch(0).at(i).write(abs(s) * s);`,
  );
  expect(got[0]).toBe(fr(fr(0.5) * fr(-0.5)));
});

// ─────────────────────────── nesting depth ──────────────────────────────────

test("STRUCT: deeply nested clamp(abs(s), min(s, 0), max(s, 1)) reads every occurrence", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(clamp(abs(s), min(s, 0), max(s, 1)));`),
    mono(d, `out.ch(0).at(i).write(clamp(abs(s.read()), min(s.read(), 0), max(s.read(), 1)));`),
  );
});

test("SEMANTIC: nested max(abs(s), s) reads both — JS reference", async () => {
  const got = await renderBlock(
    `const s = state.f32(-0.4).named("s");`,
    `out.ch(0).at(i).write(max(abs(s), s));`,
  );
  expect(got[0]).toBe(fr(Math.max(Math.abs(fr(-0.4)), fr(-0.4))));
});

// ─────────────────────────── mixed: state read as a method receiver ─────────
// `s.read().add(x)` is the explicit form; a bare `s + x` operator is the operator
// pass's job, but a state used as the receiver of an explicit `.read()` chain
// stays correct and must not double-read.

test("STRUCT: explicit s.read().mul(2) does not get a second read", async () => {
  const d = `const s = state.f32(0.5).named("s");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(s.read().mul(2));`),
    mono(d, `out.ch(0).at(i).write(s.read().mul(2));`),
  );
});
