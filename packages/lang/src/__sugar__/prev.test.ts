/**
 * EXHAUSTIVE structural + behavioral tests for the `$prev` subgraph-feedback pass
 * (RFC-001 S8). Inside a `defineSubgraph` method, `$prev` is the method's previous
 * return value. The pass:
 *   1. injects an anonymous `const __prev_N = state.<T>(0)` into the factory body,
 *   2. rewrites `$prev` → `__prev_N.read()`,
 *   3. wraps the body `(p) => e` → `(p) => { const __r = e; __prev_N.write(__r); return __r; }`.
 * The slot scalar T comes from the method's first `Node<T>` PARAMETER (default `f32`).
 *
 * Two oracles (see `../goldenHarness.ts`):
 *  - `expectSameLowering(sugar, explicit)` — the `explicit` form is hand-written
 *    chain DSL (NO operator / `$prev` sugar): it spells out the injected state slot,
 *    the `.read()`, and the store-then-return. GROUND TRUTH for structure.
 *  - `renderLowered(uwk, config)` — lower + eval + render, compared to a pure-JS
 *    IIR reference. This pins the SEMANTICS: that the feedback actually persists
 *    sample-to-sample, that independent methods get independent slots, that the
 *    literal-lift / per-op f32 rounding inside the recurrence is right.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, lower, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const N = 128;
const DUR = N / SR;
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

/** Constant-input block. */
function block(v: number): Float32Array {
  return new Float32Array(N).fill(v);
}

/** A ramp input so feedback paths are exercised with a moving signal. */
function ramp(): Float32Array {
  const a = new Float32Array(N);
  for (let n = 0; n < N; n++) a[n] = fr(Math.sin(n * 0.07));
  return a;
}

/** Lower + render a mono body against an input array; return the output channel 0. */
async function renderMono(decls: string, body: string, input: Float32Array): Promise<Float32Array> {
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [input] },
  });
  return r.outputs.main![0]!;
}

// ─────────────────────────── behavioral: one-pole IIR ────────────────────────
// y[n] = coef*x[n] + (1-coef)*y[n-1]. The slot starts at 0. This is THE canonical
// $prev recurrence. Each op rounds to f32; the literal `1` and `coef=f32(...)` lift
// to f32. A wrong pass (no slot persistence, or reading stale 0) diverges instantly.

function onepoleRef(x: Float32Array, coef: number): Float32Array {
  const c = fr(coef);
  const y = new Float32Array(x.length);
  let prev = 0;
  for (let n = 0; n < x.length; n++) {
    const v = fr(fr(c * x[n]!) + fr(fr(fr(1) - c) * prev));
    y[n] = v;
    prev = v;
  }
  return y;
}

const onepoleDecls = (coef: number): string => `
const onepole = defineSubgraph((coef: Node<"f32">) => ({
  process: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = createSubgraph(onepole, f32(${coef}), { name: "lp" });`;
const onepoleBody = `out.ch(0).at(i).write(lp.process(input.ch(0).at(i)));`;

test("SEMANTIC one-pole coef=0.5, constant input: feedback persists across samples", async () => {
  const x = block(1.0);
  const got = await renderMono(onepoleDecls(0.5), onepoleBody, x);
  const ref = onepoleRef(x, 0.5);
  for (let n = 0; n < N; n++) expect(got[n]!).toBeCloseTo(ref[n]!, 6);
  // Sanity: the value monotonically rises toward 1 — proves prev is fed back.
  expect(got[0]!).toBeCloseTo(0.5, 6);
  expect(got[1]!).toBeGreaterThan(got[0]!);
  expect(got[N - 1]!).toBeGreaterThan(0.99);
});

test("SEMANTIC one-pole coef=0.1, ramp input: matches IIR reference sample-for-sample", async () => {
  const x = ramp();
  const got = await renderMono(onepoleDecls(0.1), onepoleBody, x);
  const ref = onepoleRef(x, 0.1);
  for (let n = 0; n < N; n++) expect(got[n]!).toBeCloseTo(ref[n]!, 6);
});

test("SEMANTIC one-pole coef=1.0 degenerates to passthrough (no feedback weight)", async () => {
  const x = ramp();
  const got = await renderMono(onepoleDecls(1.0), onepoleBody, x);
  // y = 1*x + 0*prev = x
  for (let n = 0; n < N; n++) expect(got[n]!).toBeCloseTo(x[n]!, 6);
});

test("SEMANTIC one-pole coef=0.0 holds the initial slot value forever (y stays 0)", async () => {
  const x = block(1.0);
  const got = await renderMono(onepoleDecls(0.0), onepoleBody, x);
  // y = 0*x + 1*prev, prev starts 0 → stays 0
  for (let n = 0; n < N; n++) expect(got[n]!).toBe(0);
});

// ─────────────────────── structural: one-pole ≡ explicit ─────────────────────

test("STRUCT one-pole ≡ explicit hand-written slot + read + store", async () => {
  const sugar = mono(onepoleDecls(0.2), onepoleBody);
  const explicit = mono(
    `
const onepole = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    process: (x: Node<"f32">) => {
      const __r = coef.mul(x).add(sub(1, coef).mul(__prev_0.read()));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const lp = createSubgraph(onepole, f32(0.2), { name: "lp" });`,
    onepoleBody,
  );
  await expectSameLowering(sugar, explicit);
});

// ─────────────────────── behavioral: pure accumulator $prev ──────────────────
// run: (x) => x + $prev  →  running sum.  Pins that prev = previous RETURN value.

function accumRef(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  let prev = 0;
  for (let n = 0; n < x.length; n++) {
    const v = fr(x[n]! + prev);
    y[n] = v;
    prev = v;
  }
  return y;
}

test("SEMANTIC accumulator x + $prev is a running sum", async () => {
  const x = block(0.25);
  const got = await renderMono(
    `
const acc = defineSubgraph(() => ({
  run: (x: Node<"f32">) => x + $prev,
}));
const a = createSubgraph(acc, { name: "a" });`,
    `out.ch(0).at(i).write(a.run(input.ch(0).at(i)));`,
    x,
  );
  const ref = accumRef(x);
  for (let n = 0; n < N; n++) expect(got[n]!).toBeCloseTo(ref[n]!, 4);
  // running sum of 0.25: sample n holds 0.25*(n+1)
  expect(got[0]!).toBeCloseTo(0.25, 6);
  expect(got[3]!).toBeCloseTo(1.0, 5);
});

test("STRUCT accumulator x + $prev ≡ explicit; no Node<T> param ⇒ default f32 slot", async () => {
  const sugar = mono(
    `
const acc = defineSubgraph(() => ({
  run: (x: Node<"f32">) => x + $prev,
}));
const a = createSubgraph(acc, { name: "a" });`,
    `out.ch(0).at(i).write(a.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const acc = defineSubgraph(() => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = x.add(__prev_0.read());
      __prev_0.write(__r);
      return __r;
    },
  };
});
const a = createSubgraph(acc, { name: "a" });`,
    `out.ch(0).at(i).write(a.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ─────────────────────── behavioral: $prev subtraction (sign) ────────────────

test("SEMANTIC x - $prev: prev is subtracted (sign / position correct)", async () => {
  const x = block(1.0);
  const got = await renderMono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"f32">) => x - $prev,
}));
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    x,
  );
  // y[n] = x - y[n-1]; x=1: 1, 0, 1, 0, ...
  expect(got[0]!).toBe(1);
  expect(got[1]!).toBe(0);
  expect(got[2]!).toBe(1);
  expect(got[3]!).toBe(0);
});

// ─────────────────── behavioral: $prev used TWICE in one expr ────────────────

test("SEMANTIC $prev twice in one expr reads the SAME slot both times", async () => {
  const x = block(1.0);
  const coef = 0.5;
  const got = await renderMono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => $prev * coef + $prev * x,
}));
const s = createSubgraph(sg, f32(${coef}), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    x,
  );
  // y[n] = prev*coef + prev*x = prev*(coef + x); prev0=0 → all zero forever.
  for (let n = 0; n < N; n++) expect(got[n]!).toBe(0);
});

test("SEMANTIC $prev twice with additive offset grows (both reads see prev, not __r)", async () => {
  const x = block(1.0);
  const got = await renderMono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"f32">) => $prev + $prev + x,
}));
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    x,
  );
  // y[n] = 2*prev + 1; prev0=0 → 1, 3, 7, 15 ... (2^(n+1)-1)
  expect(got[0]!).toBe(1);
  expect(got[1]!).toBe(3);
  expect(got[2]!).toBe(7);
  expect(got[3]!).toBe(15);
});

test("STRUCT $prev twice ≡ explicit (single slot, two reads)", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => $prev * coef + $prev * x,
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = __prev_0.read().mul(coef).add(__prev_0.read().mul(x));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ─────────────── behavioral: MULTI-METHOD independent $prev slots ─────────────
// Two methods, each with $prev. They MUST get independent slots — if they shared
// one, calling a() would corrupt b()'s feedback. Drive them with different recurs.

test("SEMANTIC two methods, independent $prev slots (no cross-talk)", async () => {
  const x = block(1.0);
  const r = await renderLowered(
    mono(
      `
const dual = defineSubgraph(() => ({
  a: (x: Node<"f32">) => x + $prev,
  b: (y: Node<"f32">) => y - $prev,
}));
const d = createSubgraph(dual, { name: "d" });`,
      // call BOTH each sample; output a()'s result. If slots were shared, b() would
      // clobber a()'s prev and the running sum would break.
      `const av = d.a(input.ch(0).at(i)); const bv = d.b(input.ch(0).at(i)); out.ch(0).at(i).write(av);`,
    ),
    { sampleRate: SR, duration: DUR, inputs: { main: [x] } },
  );
  const got = r.outputs.main![0]!;
  // a is a pure running sum of x=1 → 1,2,3,4 regardless of b.
  expect(got[0]!).toBe(1);
  expect(got[1]!).toBe(2);
  expect(got[2]!).toBe(3);
  expect(got[3]!).toBe(4);
});

test("SEMANTIC two methods: second slot (b) behaves correctly while a also runs", async () => {
  const x = block(1.0);
  const r = await renderLowered(
    mono(
      `
const dual = defineSubgraph(() => ({
  a: (x: Node<"f32">) => x + $prev,
  b: (y: Node<"f32">) => y - $prev,
}));
const d = createSubgraph(dual, { name: "d" });`,
      `const av = d.a(input.ch(0).at(i)); const bv = d.b(input.ch(0).at(i)); out.ch(0).at(i).write(bv);`,
    ),
    { sampleRate: SR, duration: DUR, inputs: { main: [x] } },
  );
  const got = r.outputs.main![0]!;
  // b: y[n]=x-y[n-1]; x=1 → 1,0,1,0
  expect(got[0]!).toBe(1);
  expect(got[1]!).toBe(0);
  expect(got[2]!).toBe(1);
  expect(got[3]!).toBe(0);
});

test("STRUCT two methods ≡ explicit two independent slots __prev_0 / __prev_1", async () => {
  const sugar = mono(
    `
const dual = defineSubgraph((coef: Node<"f32">) => ({
  a: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
  b: (y: Node<"f32">) => y + $prev,
}));
const d = createSubgraph(dual, f32(0.3), { name: "d" });`,
    `out.ch(0).at(i).write(d.a(input.ch(0).at(i)).add(d.b(input.ch(0).at(i))));`,
  );
  const explicit = mono(
    `
const dual = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  const __prev_1 = state.f32(0);
  return {
    a: (x: Node<"f32">) => {
      const __r = coef.mul(x).add(sub(1, coef).mul(__prev_0.read()));
      __prev_0.write(__r);
      return __r;
    },
    b: (y: Node<"f32">) => {
      const __r = y.add(__prev_1.read());
      __prev_1.write(__r);
      return __r;
    },
  };
});
const d = createSubgraph(dual, f32(0.3), { name: "d" });`,
    `out.ch(0).at(i).write(d.a(input.ch(0).at(i)).add(d.b(input.ch(0).at(i))));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT interleaved methods: only $prev methods get slots; counter is per-prev-method", async () => {
  // passthru has no $prev (no slot), fb has $prev → its slot must be __prev_0 (NOT __prev_1).
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  passthru: (x: Node<"f32">) => coef * x,
  fb: (y: Node<"f32">) => y + 0.5 * $prev,
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.fb(s.passthru(input.ch(0).at(i))));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    passthru: (x: Node<"f32">) => coef.mul(x),
    fb: (y: Node<"f32">) => {
      const __r = y.add(mul(0.5, __prev_0.read()));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.fb(s.passthru(input.ch(0).at(i))));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT three methods, middle uses $prev (slot lands on __prev_0)", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  a: (x: Node<"f32">) => coef * x,
  b: (y: Node<"f32">) => y + $prev,
  c: (z: Node<"f32">) => z * coef,
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.c(s.b(s.a(input.ch(0).at(i)))));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    a: (x: Node<"f32">) => coef.mul(x),
    b: (y: Node<"f32">) => {
      const __r = y.add(__prev_0.read());
      __prev_0.write(__r);
      return __r;
    },
    c: (z: Node<"f32">) => z.mul(coef),
  };
});
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.c(s.b(s.a(input.ch(0).at(i)))));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ───────────────────────── slot TYPE from first Node param ───────────────────

test("STRUCT f64 method param ⇒ state.f64(0) slot", async () => {
  const sugar = mono(
    `
const acc = defineSubgraph(() => ({
  run: (x: Node<"f64">) => x + $prev,
}));
const a = createSubgraph(acc, { name: "a" });`,
    `out.ch(0).at(i).write(f32(a.run(f64(input.ch(0).at(i)))));`,
  );
  const explicit = mono(
    `
const acc = defineSubgraph(() => {
  const __prev_0 = state.f64(0);
  return {
    run: (x: Node<"f64">) => {
      const __r = x.add(__prev_0.read());
      __prev_0.write(__r);
      return __r;
    },
  };
});
const a = createSubgraph(acc, { name: "a" });`,
    `out.ch(0).at(i).write(f32(a.run(f64(input.ch(0).at(i)))));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT i32 method param ⇒ state.i32(0) slot", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph(() => ({
  run: (k: Node<"i32">) => k + $prev,
}));
const m = createSubgraph(sg, { name: "m" });`,
    `out.ch(0).at(i).write(f32(m.run(i32(1))));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph(() => {
  const __prev_0 = state.i32(0);
  return {
    run: (k: Node<"i32">) => {
      const __r = k.add(__prev_0.read());
      __prev_0.write(__r);
      return __r;
    },
  };
});
const m = createSubgraph(sg, { name: "m" });`,
    `out.ch(0).at(i).write(f32(m.run(i32(1))));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT i64 method param ⇒ state.i64(0) slot", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"i64">) => x + $prev,
}));
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(f32(0));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph(() => {
  const __prev_0 = state.i64(0);
  return {
    run: (x: Node<"i64">) => {
      const __r = x.add(__prev_0.read());
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(f32(0));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT first param is `number` (build-time): slot type taken from 2nd, the Node<i32> param", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph(() => ({
  run: (k: number, x: Node<"i32">) => x + $prev,
}));
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(f32(0));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph(() => {
  const __prev_0 = state.i32(0);
  return {
    run: (k: number, x: Node<"i32">) => {
      const __r = x.add(__prev_0.read());
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(f32(0));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ─────────────────────── $prev in different expr positions ───────────────────

test("STRUCT $prev inside select (ternary) position lowers correctly", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((g: Node<"f32">) => ({
  run: (x: Node<"f32">) => x > 0 ? x : $prev,
}));
const s = createSubgraph(sg, f32(0), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((g: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = select(x.gt(0), x, __prev_0.read());
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, f32(0), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("SEMANTIC $prev inside ternary acts as sample-and-hold (holds last positive)", async () => {
  // y = x>0 ? x : prev  → holds the most recent positive sample.
  const x = new Float32Array(N);
  x[0] = 0.5;
  x[1] = -1; // hold 0.5
  x[2] = -1; // hold 0.5
  x[3] = 0.8;
  x[4] = -1; // hold 0.8
  const got = await renderMono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"f32">) => x > 0 ? x : $prev,
}));
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    x,
  );
  expect(got[0]!).toBeCloseTo(0.5, 6);
  expect(got[1]!).toBeCloseTo(0.5, 6);
  expect(got[2]!).toBeCloseTo(0.5, 6);
  expect(got[3]!).toBeCloseTo(0.8, 6);
  expect(got[4]!).toBeCloseTo(0.8, 6);
});

test("STRUCT $prev inside clamp() call argument lowers correctly", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => clamp(coef * x + (1 - coef) * $prev, -1, 1),
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = clamp(coef.mul(x).add(sub(1, coef).mul(__prev_0.read())), -1, 1);
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT bare $prev only (identity feedback) ≡ explicit read", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"f32">) => $prev,
}));
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph(() => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = __prev_0.read();
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ─────────────── $prev combined with bare-state + param + operators ──────────

test("STRUCT $prev combined with an outer bare State read ≡ explicit", async () => {
  const sugar = mono(
    `
const fb = state.f32(0).named("fb");
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + fb * $prev,
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const fb = state.f32(0).named("fb");
const sg = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = coef.mul(x).add(fb.read().mul(__prev_0.read()));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ─────────────── createSubgraph with an operator / const arg ─────────────────

test("STRUCT createSubgraph with an operator arg lowers the arg (Node + Node ⇒ add)", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = createSubgraph(sg, f32(0.1) + f32(0.2), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = coef.mul(x).add(sub(1, coef).mul(__prev_0.read()));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const lp = createSubgraph(sg, f32(0.1).add(f32(0.2)), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT createSubgraph with a build-time const arg stays JS (0.5 * 0.5 not lowered)", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = createSubgraph(sg, f32(0.5 * 0.5), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
  );
  // Ground truth: the arg is a plain `f32(0.25)` because `0.5 * 0.5` is build-time.
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = coef.mul(x).add(sub(1, coef).mul(__prev_0.read()));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const lp = createSubgraph(sg, f32(0.25), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("DEBUG createSubgraph const arg lowers `0.5 * 0.5` as a number, not mul()", () => {
  const out = lower(
    mono(
      `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = createSubgraph(sg, f32(0.5 * 0.5), { name: "lp" });`,
      `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
    ),
  );
  expect(out).toMatch(/createSubgraph\(sg, f32\(0\.5 \* 0\.5\)/);
  expect(out).not.toMatch(/createSubgraph\(sg, f32\(mul\(/);
});

// ─────────────────────────── nested subgraphs ───────────────────────────────

test("STRUCT $prev inside an INNER defineSubgraph (nested) lowers; outer has no slot", async () => {
  const sugar = mono(
    `
const inner = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const outer = defineSubgraph(() => {
  const lp = createSubgraph(inner, f32(0.5));
  return { run: (x: Node<"f32">) => lp.run(x) };
});
const s = createSubgraph(outer, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const inner = defineSubgraph((coef: Node<"f32">) => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const __r = coef.mul(x).add(sub(1, coef).mul(__prev_0.read()));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const outer = defineSubgraph(() => {
  const lp = createSubgraph(inner, f32(0.5));
  return { run: (x: Node<"f32">) => lp.run(x) };
});
const s = createSubgraph(outer, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("SEMANTIC nested subgraph one-pole through outer wrapper matches IIR ref", async () => {
  const x = ramp();
  const got = await renderMono(
    `
const inner = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const outer = defineSubgraph(() => {
  const lp = createSubgraph(inner, f32(0.3));
  return { run: (x: Node<"f32">) => lp.run(x) };
});
const s = createSubgraph(outer, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    x,
  );
  const ref = onepoleRef(x, 0.3);
  for (let n = 0; n < N; n++) expect(got[n]!).toBeCloseTo(ref[n]!, 6);
});

// ─────────────────── negative guard: NOT a $prev context ─────────────────────

test("STRUCT a subgraph with NO $prev gets no slot and no store wrap", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x,
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef.mul(x),
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("DEBUG no-$prev subgraph: lowered output has no state slot injected", () => {
  const out = lower(
    mono(
      `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x,
}));
const s = createSubgraph(sg, f32(0.5), { name: "s" });`,
      `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    ),
  );
  expect(out).not.toMatch(/__prev_/);
  expect(out).not.toMatch(/state\.f32/);
});
