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
const lp = instantiate(onepole, f32(${coef}), { name: "lp" });`;
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
const lp = instantiate(onepole, f32(0.2), { name: "lp" });`,
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
const a = instantiate(acc, { name: "a" });`,
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
const a = instantiate(acc, { name: "a" });`,
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
const a = instantiate(acc, { name: "a" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, f32(${coef}), { name: "s" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const d = instantiate(dual, { name: "d" });`,
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
const d = instantiate(dual, { name: "d" });`,
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
const d = instantiate(dual, f32(0.3), { name: "d" });`,
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
const d = instantiate(dual, f32(0.3), { name: "d" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const a = instantiate(acc, { name: "a" });`,
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
const a = instantiate(acc, { name: "a" });`,
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
const m = instantiate(sg, { name: "m" });`,
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
const m = instantiate(sg, { name: "m" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, f32(0), { name: "s" });`,
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
const s = instantiate(sg, f32(0), { name: "s" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ─────────────── instantiate with an operator / const arg ─────────────────

test("STRUCT instantiate with an operator arg lowers the arg (Node + Node ⇒ add)", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = instantiate(sg, f32(0.1) + f32(0.2), { name: "lp" });`,
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
const lp = instantiate(sg, f32(0.1).add(f32(0.2)), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT instantiate with a build-time const arg stays JS (0.5 * 0.5 not lowered)", async () => {
  const sugar = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = instantiate(sg, f32(0.5 * 0.5), { name: "lp" });`,
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
const lp = instantiate(sg, f32(0.25), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("DEBUG instantiate const arg lowers `0.5 * 0.5` as a number, not mul()", () => {
  const out = lower(
    mono(
      `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const lp = instantiate(sg, f32(0.5 * 0.5), { name: "lp" });`,
      `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`,
    ),
  );
  expect(out).toMatch(/instantiate\(sg, f32\(0\.5 \* 0\.5\)/);
  expect(out).not.toMatch(/instantiate\(sg, f32\(mul\(/);
});

// ─────────────────────────── nested subgraphs ───────────────────────────────

test("STRUCT $prev inside an INNER defineSubgraph (nested) lowers; outer has no slot", async () => {
  const sugar = mono(
    `
const inner = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
}));
const outer = defineSubgraph(() => {
  const lp = instantiate(inner, f32(0.5));
  return { run: (x: Node<"f32">) => lp.run(x) };
});
const s = instantiate(outer, { name: "s" });`,
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
  const lp = instantiate(inner, f32(0.5));
  return { run: (x: Node<"f32">) => lp.run(x) };
});
const s = instantiate(outer, { name: "s" });`,
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
  const lp = instantiate(inner, f32(0.3));
  return { run: (x: Node<"f32">) => lp.run(x) };
});
const s = instantiate(outer, { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph((coef: Node<"f32">) => ({
  run: (x: Node<"f32">) => coef.mul(x),
}));
const s = instantiate(sg, f32(0.5), { name: "s" });`,
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
const s = instantiate(sg, f32(0.5), { name: "s" });`,
      `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    ),
  );
  expect(out).not.toMatch(/__prev_/);
  expect(out).not.toMatch(/state\.f32/);
});

// ──────────────── nested return advances the slot (build-time branch) ─────────
// A $prev method whose returned value sits inside a nested branch must store the
// slot on THAT path too. `if (true)` is the meta-program path: the captured return
// is the nested one, so wrapping only direct returns would never write the slot
// and the feedback would silently vanish. (Reported by @codex on #12.)

function nestedIirRef(x: Float32Array, fb: number): Float32Array {
  const y = new Float32Array(x.length);
  let prev = 0;
  for (let n = 0; n < x.length; n++) {
    const v = fr(x[n]! + fr(prev * fb)); // x + ($prev * fb), f32 per op
    y[n] = v;
    prev = v;
  }
  return y;
}

test("SEMANTIC $prev in a build-time branch's nested return still feeds back", async () => {
  const x = ramp();
  const got = await renderMono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"f32">) => {
    if (true) return x + $prev * 0.5;
    return x;
  },
}));
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
    x,
  );
  const ref = nestedIirRef(x, 0.5);
  // With the bug (only direct returns wrapped) the slot is never written and the
  // output collapses to x[n] with no feedback — this pins the recurrence instead.
  for (let n = 0; n < N; n++) expect(got[n]!).toBeCloseTo(ref[n]!, 4);
  // Sanity: the feedback term moves the output away from the raw input.
  expect(got[5]!).not.toBeCloseTo(fr(x[5]!), 4);
});

// ──────────────── slot type comes from the RETURN, not the param (#47) ─────────
// The $prev slot stores the method's previous RETURN value, so its scalar type
// must match the return — NOT the first parameter. Here the method takes a
// Node<'bool'> trigger but returns Node<'f32'>; reading the slot type off the
// param gives a bool slot that truncates the f32 decay envelope to 0/1.
// (Reported by @codex on #12 J2.)

function decayRef(impulse: Float32Array): Float32Array {
  const y = new Float32Array(impulse.length);
  let prev = 0;
  for (let n = 0; n < impulse.length; n++) {
    const v = impulse[n]! > 0.5 ? 1 : fr(prev * 0.95);
    y[n] = v;
    prev = v;
  }
  return y;
}

test("SEMANTIC $prev slot type follows the RETURN (bool param, f32 return → f32 decay)", async () => {
  const impulse = new Float32Array(N);
  impulse[0] = 1; // single trigger at sample 0, then silence
  const got = await renderMono(
    `
const decay = defineSubgraph(() => ({
  run: (trigger: Node<"bool">): Node<"f32"> => select(trigger, f32(1), $prev * 0.95),
}));
const d = instantiate(decay, { name: "d" });`,
    `out.ch(0).at(i).write(d.run(input.ch(0).at(i) > 0.5));`,
    impulse,
  );
  const ref = decayRef(impulse);
  // The envelope must decay smoothly as f32 (1, 0.95, 0.95², …). A bool slot pins
  // $prev to 0/1 and the decay never happens.
  for (let n = 0; n < N; n++) expect(got[n]!).toBeCloseTo(ref[n]!, 4);
  expect(got[0]!).toBeCloseTo(1, 5);
  expect(got[3]!).toBeCloseTo(fr(fr(fr(1 * 0.95) * 0.95) * 0.95), 4); // ≈ 0.857, not 0/1
});

test("SEMANTIC $prev slot type from a NO-ARG method's return annotation (f64)", async () => {
  // No parameter to read a type from, so the old default (f32) is wrong: the body
  // mixes the f64 slot with f64 literals and would not compile as f32. The return
  // annotation `Node<"f64">` is authoritative.
  const got = await renderMono(
    `
const acc = defineSubgraph(() => ({
  step: (): Node<"f64"> => $prev.mul(f64(0.5)).add(f64(0.25)),
}));
const a = instantiate(acc, { name: "a" });`,
    `out.ch(0).at(i).write(f32(a.step()));`,
    block(0),
  );
  // prev=0 → 0.25, 0.375, 0.4375, … converging to 0.5 (computed in f64).
  expect(got[0]!).toBeCloseTo(0.25, 5);
  expect(got[1]!).toBeCloseTo(0.375, 5);
  expect(got[2]!).toBeCloseTo(0.4375, 5);
  expect(got[N - 1]!).toBeCloseTo(0.5, 4);
});

test("SEMANTIC $prev slot type from the return EXPRESSION when un-annotated (i32 param, f32 return)", async () => {
  // No return annotation; the param is i32 but the body is anchored by f32(...),
  // so the return type is f32. The checker resolves the method-form body, so the
  // slot is f32 (not i32 from the param).
  const got = await renderMono(
    `
const sg = defineSubgraph(() => ({
  run: (steps: Node<"i32">) => f32(steps).mul(f32(0.1)).add($prev.mul(f32(0.5))),
}));
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(i32(2)));`,
    block(0),
  );
  // v = f32(2)*0.1 + prev*0.5 = 0.2 + prev*0.5 → 0.2, 0.3, 0.35, … → 0.4 (f32).
  expect(got[0]!).toBeCloseTo(fr(0.2), 5);
  expect(got[1]!).toBeCloseTo(fr(fr(0.2) + fr(fr(0.2) * 0.5)), 5);
  expect(got[N - 1]!).toBeCloseTo(0.4, 3);
});

// ───────────────────── slot-type edge cases (un-annotated / side-effect) ─────
// $prev methods whose slot type cannot be read from a return-type annotation or a
// resolvable return-expression type fall back through the parameter, then to f32.

test("SEMANTIC un-annotated $prev method with no return: the slot never advances", async () => {
  // The method uses $prev only for a side-effect write and has NO `return`, so the
  // store-then-return wrapper never runs — the slot holds its initial 0 forever and
  // `$prev` reads 0 every sample. The slot scalar comes from the i32 parameter, so
  // the integer recurrence stays exact.
  const got = await renderMono(
    `
const acc = state.i32(0).named("acc");
const sg = defineSubgraph(() => ({
  bump: (step: Node<"i32">) => { acc.write(($prev + step) % 4); },
}));
const s = instantiate(sg, { name: "s" });`,
    `s.bump(i32(1));\nout.ch(0).at(i).write(f32(acc.read()));`,
    block(0),
  );
  // $prev stays 0 (no return advances it): acc = (0 + 1) % 4 = 1 every sample.
  for (let n = 0; n < N; n++) expect(got[n]!).toBe(1);
});

test("STRUCT a no-param, un-annotated $prev method falls all the way back to an f32 slot", async () => {
  // No return-type annotation, the return expression (`$prev`) types as the broad
  // ambient `Node<ScalarType>` (no concrete scalar), and there is no parameter — so
  // the slot scalar defaults to f32. The explicit form spells the f32 slot out.
  const sugar = mono(
    `
const sg = defineSubgraph(() => ({
  tick: () => $prev,
}));
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.tick());`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph(() => {
  const __prev_0 = state.f32(0);
  return {
    tick: () => {
      const __r = __prev_0.read();
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.tick());`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT $prev method with a NON-Node return annotation ≡ explicit i32 slot", async () => {
  // A return-type annotation that is not a `Node<'X'>` brand cannot pin the slot, so
  // the pass falls through to the i32 parameter. The explicit form spells the i32 slot.
  const sugar = mono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"i32">): unknown => $prev + x,
}));
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(f32(s.run(i32(1))));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph(() => {
  const __prev_0 = state.i32(0);
  return {
    run: (x: Node<"i32">): unknown => {
      const __r = __prev_0.read().add(x);
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(f32(s.run(i32(1))));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("STRUCT a nested closure return inside a $prev method is NOT slot-wrapped", async () => {
  // `wrapReturns` must stop at function boundaries: the inner `() => 1` closure's
  // return belongs to the closure, not the method, so only the method's own return
  // stores the slot. The explicit form keeps the closure's `return 1` untouched.
  const sugar = mono(
    `
const sg = defineSubgraph(() => ({
  run: (x: Node<"f32">) => {
    const k = (() => 1)();
    return x + $prev * f32(k);
  },
}));
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `
const sg = defineSubgraph(() => {
  const __prev_0 = state.f32(0);
  return {
    run: (x: Node<"f32">) => {
      const k = (() => 1)();
      const __r = x.add(__prev_0.read().mul(f32(k)));
      __prev_0.write(__r);
      return __r;
    },
  };
});
const s = instantiate(sg, { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ───────────────────── subgraphs the $prev pass leaves untouched ─────────────
// A `defineSubgraph` whose factory does not return an object-literal of methods, or
// is not an inline arrow, carries no `$prev` slot — the pass passes it through.

test("a defineSubgraph factory with a block body and no return is passed through", () => {
  // The factory block has no `return`, so there is no methods object to scan — the
  // pass must leave the call as-is rather than crash.
  const src = mono(
    `
const weird = defineSubgraph((k: Node<"f32">) => {
  const unused = k;
});`,
    `out.ch(0).at(i).write(input.ch(0).at(i));`,
  );
  const lowered = lower(src);
  expect(lowered).toContain("defineSubgraph");
  expect(lowered).not.toContain("__prev_");
});

test("a defineSubgraph factory that returns a non-object value is passed through", () => {
  // Block-bodied `=> { return k; }` and concise `=> k` both return a non-object, so
  // there is no methods object and no slot to inject.
  const blockForm = mono(
    `const a = defineSubgraph((k: Node<"f32">) => { return k; });`,
    `out.ch(0).at(i).write(input.ch(0).at(i));`,
  );
  const conciseForm = mono(
    `const b = defineSubgraph((k: Node<"f32">) => k);`,
    `out.ch(0).at(i).write(input.ch(0).at(i));`,
  );
  expect(lower(blockForm)).toContain("defineSubgraph");
  expect(lower(blockForm)).not.toContain("__prev_");
  expect(lower(conciseForm)).toContain("defineSubgraph");
  expect(lower(conciseForm)).not.toContain("__prev_");
});

test("a defineSubgraph whose factory is a named reference (not an inline arrow) is passed through", () => {
  // `defineSubgraph(factory)` cannot be scanned for `$prev` (the arrow lives in a
  // separate binding), so the pass leaves it untouched.
  const src = mono(
    `
const factory = (k: Node<"f32">) => ({ run: (x: Node<"f32">) => k * x });
const sg = defineSubgraph(factory);
const s = instantiate(sg, f32(0.5), { name: "s" });`,
    `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`,
  );
  const lowered = lower(src);
  expect(lowered).toContain("defineSubgraph(factory)");
  expect(lowered).not.toContain("__prev_");
});
