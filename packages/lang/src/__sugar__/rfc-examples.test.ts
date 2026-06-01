/**
 * RFC-001 canonical-example lowering tests (adversarial).
 *
 * Each RFC §"Examples" snippet (Ex1 stereo gain + meter, Ex2 peaking biquad +
 * direct-form-II + $prev, Ex4 lookahead limiter, Ex5 granular voice, Ex6 MIDI
 * arpeggiator) is translated to its `.uwk.ts` sugar form and pinned two ways:
 *
 *  - `expectSameLowering(sugar, explicit)` — the explicit form is hand-written
 *    chain DSL (no operator / index / bare-state / if sugar) = ground truth. A
 *    structural fingerprint match proves the sugar lowered to the same graph.
 *  - `renderLowered` + a pure-JS reference — the high-confidence SEMANTIC probe.
 *    JS f32 math (`Math.fround`) is unambiguous, so it catches wrong precedence,
 *    wrong literal-lift type, off-by-one indexing, int-vs-float mistakes.
 *
 * NOTE 1 — implemented State API: the RFC prose says `state.store(v)` /
 * `state.load()`, but the shipped `@unworklet/core` `State<T>` uses `write(v)` /
 * `read()`. These tests target the IMPLEMENTED API (bare-state in a `Node`
 * position lowers to `.read()`).
 *
 * NOTE 2 — type-soundness gap that shapes these tests. The lowering's
 * type-directed dispatch queries STOCK TypeScript types (no operator-overload
 * LSP plugin). Index-access sugar (`channel[i]`, `param[i]`, `buffer[i]`) and
 * comparison sugar (`a > b`) are typed `any` / `boolean` by stock TS, so:
 *   - an operator whose ONLY DSP operand is an index-access expression does NOT
 *     lower (`input.left[i] * gain[i]` survives as raw JS `*` → NaN);
 *   - a `const` bound to such an expression is typed `any`, so DOWNSTREAM sugar
 *     referencing it also fails to lower.
 * Several canonical snippets hit this and are recorded in the agent report as
 * suspected lang bugs rather than asserted here. Where a canonical example has a
 * faithful form that DOES lower (one operand reaches `Node` via `.at(i)` method
 * form, or a bare `State`/`Node` operand), that form is exercised below.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const DUR = 128 / SR;
const fr = Math.fround;

/** Mono processor wrapper. */
const mono = (decls: string, body: string): string => `
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => { forSample((i) => { ${body} }); });
`;

/** Stereo processor wrapper. */
const stereo = (decls: string, body: string): string => `
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
${decls}
process(() => { forSample((i) => { ${body} }); });
`;

const ramp = (n: number, f: (k: number) => number): Float32Array => {
  const a = new Float32Array(n);
  for (let k = 0; k < n; k++) a[k] = f(k);
  return a;
};

// ════════════════════════════════════════════════════════════════════════
// Ex 1 — Stereo gain + level meter (RFC §"Ex 1")
//
// The flagship sugar `out.left[i] = input.left[i] * gain[i]` does NOT lower
// (both operands are index-sugar → typed `any` → operator pass leaves raw `*`).
// Recorded as a suspected bug. The faithful form that DOES lower keeps the
// audio-input read in `.at(i)` method form so the multiply has a `Node` operand.
// ════════════════════════════════════════════════════════════════════════

test("Ex1: stereo gain `input.left.at(i) * gain[i]` ≡ chain (mixed method/index sugar)", async () => {
  const decls = `const gain = param.f32({ default: 1, min: 0, max: 4 });`;
  const sugar = stereo(
    decls,
    `out.left[i] = input.left.at(i) * gain[i];
     out.right[i] = input.right.at(i) * gain[i];`,
  );
  const explicit = stereo(
    decls,
    `out.left.at(i).write(input.left.at(i).mul(gain.at(i)));
     out.right.at(i).write(input.right.at(i).mul(gain.at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex1 behavioral: stereo gain applies param to both channels", async () => {
  const uwk = stereo(
    `const gain = param.f32({ default: 1, min: 0, max: 4 });`,
    `out.left[i] = input.left.at(i) * gain[i];
     out.right[i] = input.right.at(i) * gain[i];`,
  );
  const l = ramp(128, (k) => fr(0.01 * (k + 1)));
  const r = ramp(128, (k) => fr(-0.02 * (k + 1)));
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [l, r] },
    params: { gain: [2] },
  });
  for (let k = 0; k < 8; k++) {
    expect(res.outputs.main![0]![k]!).toBeCloseTo(fr(fr(l[k]!) * fr(2)), 6);
    expect(res.outputs.main![1]![k]!).toBeCloseTo(fr(fr(r[k]!) * fr(2)), 6);
  }
});

test("Ex1 meter: `meterL.write(max(abs(l), meterL))` bare-state read ≡ chain", async () => {
  const decls = `const meterL = state.f32(0);`;
  const sugar = mono(
    decls,
    `const l = input.ch(0).at(i);
     meterL.write(max(abs(l), meterL));
     out.ch(0).at(i).write(meterL);`,
  );
  const explicit = mono(
    decls,
    `const l = input.ch(0).at(i);
     meterL.write(max(abs(l), meterL.read()));
     out.ch(0).at(i).write(meterL.read());`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex1 meter behavioral: running peak-hold of |l| (bare-state read each sample)", async () => {
  // meterL = max(|l|, meterL) per sample. Explicit name on .expose (the auto-name
  // pass does NOT fill `.expose()` names — recorded as a suspected bug).
  const uwk = mono(
    `const meterL = state.f32(0).expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } });`,
    `const l = input.ch(0).at(i);
     meterL.write(max(abs(l), meterL));
     out.ch(0).at(i).write(meterL);`,
  );
  const l = ramp(128, (k) => fr(0.001 * (k - 40)));
  const res = await renderLowered(uwk, { sampleRate: SR, duration: DUR, inputs: { main: [l] } });
  let m = 0;
  const ref: number[] = [];
  for (let k = 0; k < 128; k++) {
    m = Math.max(Math.abs(fr(l[k]!)), m);
    ref.push(m);
  }
  for (let k = 0; k < 128; k += 16) expect(res.outputs.main![0]![k]!).toBeCloseTo(ref[k]!, 5);
  for (let k = 1; k < 128; k++) {
    expect(res.outputs.main![0]![k]!).toBeGreaterThanOrEqual(res.outputs.main![0]![k - 1]! - 1e-7);
  }
});

// ════════════════════════════════════════════════════════════════════════
// Ex 2 — Peaking biquad coefficients + Direct-Form-II-Transposed + $prev
//
// The coefficient helper takes TYPED `Node<'f32'>` params, so every const
// (`A = exp(...)`, `cosw0 = cos(w0)`, `alpha = sin(w0)/(q*2)`) is properly
// `Node`-typed and the full Audio-EQ-cookbook infix lowers. This is the form
// the RFC actually ships.
// ════════════════════════════════════════════════════════════════════════

const PEAKING_HELPER = `
const sr = 48000;
function peakingCoeffs(freq: Node<"f32">, q: Node<"f32">, gainDb: Node<"f32">) {
  const A = exp(gainDb * (0.05 * Math.LN10));
  const w0 = freq * ((2 * Math.PI) / sr);
  const cosw0 = cos(w0);
  const alpha = sin(w0) / (q * 2);
  const inv = 1 / (1 + alpha / A);
  return {
    b0: (1 + alpha * A) * inv,
    b1: -2 * cosw0 * inv,
    b2: (1 - alpha * A) * inv,
    a1: -2 * cosw0 * inv,
    a2: (1 - alpha / A) * inv,
  };
}`;

const PEAKING_HELPER_EXPLICIT = `
const sr = 48000;
function peakingCoeffs(freq: Node<"f32">, q: Node<"f32">, gainDb: Node<"f32">) {
  const A = exp(gainDb.mul(0.05 * Math.LN10));
  const w0 = freq.mul((2 * Math.PI) / sr);
  const cosw0 = cos(w0);
  const alpha = sin(w0).div(q.mul(2));
  const inv = num(1).div(num(1).add(alpha.div(A)));
  return {
    b0: num(1).add(alpha.mul(A)).mul(inv),
    b1: num(-2).mul(cosw0).mul(inv),
    b2: num(1).sub(alpha.mul(A)).mul(inv),
    a1: num(-2).mul(cosw0).mul(inv),
    a2: num(1).sub(alpha.div(A)).mul(inv),
  };
}`;

const COEF_PORTS = `
const fp = param.f32({ default: 1000, min: 20, max: 20000 });
const qp = param.f32({ default: 1, min: 0.1, max: 10 });
const gp = param.f32({ default: 0, min: -24, max: 24 });`;

test("Ex2 peakingCoeffs: Audio-EQ-cookbook infix ≡ chain DSL (b1: -2·cosw0·inv)", async () => {
  const sugar = mono(
    PEAKING_HELPER + COEF_PORTS,
    `const c = peakingCoeffs(fp.at(i), qp.at(i), gp.at(i)); out.ch(0).at(i).write(c.b1);`,
  );
  const explicit = mono(
    PEAKING_HELPER_EXPLICIT + COEF_PORTS,
    `const c = peakingCoeffs(fp.at(i), qp.at(i), gp.at(i)); out.ch(0).at(i).write(c.b1);`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex2 peakingCoeffs: all five coefficients lower identically to chain", async () => {
  const fields = ["b0", "b1", "b2", "a1", "a2"];
  for (const fld of fields) {
    const sugar = mono(
      PEAKING_HELPER + COEF_PORTS,
      `const c = peakingCoeffs(fp.at(i), qp.at(i), gp.at(i)); out.ch(0).at(i).write(c.${fld});`,
    );
    const explicit = mono(
      PEAKING_HELPER_EXPLICIT + COEF_PORTS,
      `const c = peakingCoeffs(fp.at(i), qp.at(i), gp.at(i)); out.ch(0).at(i).write(c.${fld});`,
    );
    await expectSameLowering(sugar, explicit);
  }
});

test("Ex2 peakingCoeffs behavioral: b0 = (1+α·A)·inv matches the cookbook formula", async () => {
  const uwk = mono(
    PEAKING_HELPER + COEF_PORTS,
    `const c = peakingCoeffs(fp.at(i), qp.at(i), gp.at(i)); out.ch(0).at(i).write(c.b0);`,
  );
  const freq = 1000,
    q = 1,
    gainDb = 6;
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [new Float32Array(128)] },
    params: { fp: [freq], qp: [q], gp: [gainDb] },
  });
  const A = fr(Math.exp(fr(gainDb * (0.05 * Math.LN10))));
  const w0 = fr(freq * ((2 * Math.PI) / SR));
  const alpha = fr(Math.sin(w0) / fr(q * 2));
  const inv = fr(1 / fr(1 + fr(alpha / A)));
  const b0 = fr(fr(1 + fr(alpha * A)) * inv);
  expect(res.outputs.main![0]![0]!).toBeCloseTo(b0, 3);
});

test("Ex2 DF2T: `y = b0*x + z1; z1.write(b1*x + z2 - a1*y)` ≡ chain", async () => {
  // `x = input.ch(0).at(i)` is `Node`-typed (method form), so every `* x` / `* y`
  // multiply reaches a `Node` operand and lowers; coefficient consts are derived
  // from `x`/`y` products, not bare `param[i]`.
  const decls = `
const z1 = state.f32(0);
const z2 = state.f32(0);
const b0p = param.f32({ default: 1, min: 0, max: 2 });
const b1p = param.f32({ default: 0, min: -2, max: 2 });
const b2p = param.f32({ default: 0, min: -2, max: 2 });
const a1p = param.f32({ default: 0, min: -2, max: 2 });
const a2p = param.f32({ default: 0, min: -2, max: 2 });`;
  const sugar = mono(
    decls,
    `const x = input.ch(0).at(i);
     const y = b0p.at(i) * x + z1;
     z1.write(b1p.at(i) * x + z2 - a1p.at(i) * y);
     z2.write(b2p.at(i) * x - a2p.at(i) * y);
     out.ch(0).at(i).write(y);`,
  );
  const explicit = mono(
    decls,
    `const x = input.ch(0).at(i);
     const y = b0p.at(i).mul(x).add(z1.read());
     z1.write(b1p.at(i).mul(x).add(z2.read()).sub(a1p.at(i).mul(y)));
     z2.write(b2p.at(i).mul(x).sub(a2p.at(i).mul(y)));
     out.ch(0).at(i).write(y);`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex2 DF2T behavioral: matches a JS reference biquad sample-for-sample", async () => {
  const uwk = mono(
    `
const z1 = state.f32(0);
const z2 = state.f32(0);
const b0p = param.f32({ default: 1, min: -2, max: 2 });
const b1p = param.f32({ default: 0, min: -2, max: 2 });
const b2p = param.f32({ default: 0, min: -2, max: 2 });
const a1p = param.f32({ default: 0, min: -2, max: 2 });
const a2p = param.f32({ default: 0, min: -2, max: 2 });`,
    `const x = input.ch(0).at(i);
     const y = b0p.at(i) * x + z1;
     z1.write(b1p.at(i) * x + z2 - a1p.at(i) * y);
     z2.write(b2p.at(i) * x - a2p.at(i) * y);
     out.ch(0).at(i).write(y);`,
  );
  const B0 = 0.5,
    B1 = 0.25,
    B2 = -0.125,
    A1 = -0.3,
    A2 = 0.2;
  const x = ramp(128, (k) => fr(Math.sin((k * 2 * Math.PI) / 17) * 0.5));
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
    params: { b0p: [B0], b1p: [B1], b2p: [B2], a1p: [A1], a2p: [A2] },
  });
  let z1 = 0,
    z2 = 0;
  const ref: number[] = [];
  for (let k = 0; k < 128; k++) {
    const xn = fr(x[k]!);
    const y = fr(fr(B0 * xn) + z1);
    z1 = fr(fr(fr(B1 * xn) + z2) - fr(A1 * y));
    z2 = fr(fr(B2 * xn) - fr(A2 * y));
    ref.push(y);
  }
  for (let k = 0; k < 128; k += 8) expect(res.outputs.main![0]![k]!).toBeCloseTo(ref[k]!, 5);
});

test("Ex2 $prev one-pole: `coef*x + (1-coef)*$prev` ≡ explicit injected-state chain", async () => {
  const sugar = mono(
    `const onepole = defineSubgraph((coef: Node<"f32">) => ({
       process: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
     }));
     const lp = createSubgraph(onepole, f32(0.5), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.process(input.ch(0).at(i)));`,
  );
  const explicit = mono(
    `const onepole = defineSubgraph((coef: Node<"f32">) => {
       const slot = state.f32(0);
       return {
         process: (x: Node<"f32">) => {
           const r = coef.mul(x).add(num(1).sub(coef).mul(slot.read()));
           slot.write(r);
           return r;
         },
       };
     });
     const lp = createSubgraph(onepole, f32(0.5), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.process(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex2 $prev behavioral: one-pole low-pass step response, coef=0.5", async () => {
  const uwk = mono(
    `const onepole = defineSubgraph((coef: Node<"f32">) => ({
       process: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
     }));
     const lp = createSubgraph(onepole, f32(0.5), { name: "lp" });`,
    `out.ch(0).at(i).write(lp.process(input.ch(0).at(i)));`,
  );
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [new Float32Array(128).fill(1)] },
  });
  let y = 0;
  const ref: number[] = [];
  for (let k = 0; k < 128; k++) {
    y = fr(fr(fr(0.5) * fr(1)) + fr(fr(fr(1) - fr(0.5)) * y));
    ref.push(y);
  }
  for (let k = 0; k < 16; k++) expect(res.outputs.main![0]![k]!).toBeCloseTo(ref[k]!, 6);
});

test("Ex2 $prev multi-method: each method gets an independent slot", async () => {
  // Two methods both use $prev; the slots must be distinct (processL feedback
  // must not leak into processR). Each result is written to its own channel —
  // combining two subgraph-method results with an operator does NOT lower
  // (the method-call result is not `Node`-typed by stock TS; recorded).
  const sugar = stereo(
    `const sop = defineSubgraph((coef: Node<"f32">) => ({
       processL: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
       processR: (x: Node<"f32">) => coef * x + (1 - coef) * $prev,
     }));
     const s = createSubgraph(sop, f32(0.5), { name: "s" });`,
    `out.left.at(i).write(s.processL(input.left.at(i)));
     out.right.at(i).write(s.processR(input.right.at(i)));`,
  );
  const explicit = stereo(
    `const sop = defineSubgraph((coef: Node<"f32">) => {
       const slotL = state.f32(0);
       const slotR = state.f32(0);
       return {
         processL: (x: Node<"f32">) => {
           const r = coef.mul(x).add(num(1).sub(coef).mul(slotL.read()));
           slotL.write(r);
           return r;
         },
         processR: (x: Node<"f32">) => {
           const r = coef.mul(x).add(num(1).sub(coef).mul(slotR.read()));
           slotR.write(r);
           return r;
         },
       };
     });
     const s = createSubgraph(sop, f32(0.5), { name: "s" });`,
    `out.left.at(i).write(s.processL(input.left.at(i)));
     out.right.at(i).write(s.processR(input.right.at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ════════════════════════════════════════════════════════════════════════
// Ex 4 — Lookahead limiter inner loop (envelope follow, ternary gr, %, if-emit)
// ════════════════════════════════════════════════════════════════════════

const ENV_HELPER = `
function envelopeFollow(x: Node<"f32">, attackCoef: Node<"f32">, releaseCoef: Node<"f32">, prev: State<"f32">): Node<"f32"> {
  const r = abs(x);
  const coef = r > prev ? attackCoef : releaseCoef;
  const y = (r - prev) * coef + prev;
  prev.write(y);
  return y;
}`;
const ENV_HELPER_EXPLICIT = `
function envelopeFollow(x: Node<"f32">, attackCoef: Node<"f32">, releaseCoef: Node<"f32">, prev: State<"f32">): Node<"f32"> {
  const r = abs(x);
  const coef = select(r.gt(prev.read()), attackCoef, releaseCoef);
  const y = r.sub(prev.read()).mul(coef).add(prev.read());
  prev.write(y);
  return y;
}`;

test("Ex4 envelope follower: `coef = r>prev ? attack : release` ternary ≡ select", async () => {
  const decls = `const env = state.f32(0); const aC = param.f32({default:0.5,min:0,max:1}); const rC = param.f32({default:0.1,min:0,max:1});`;
  const body = `out.ch(0).at(i).write(envelopeFollow(input.ch(0).at(i), aC.at(i), rC.at(i), env));`;
  await expectSameLowering(mono(ENV_HELPER + decls, body), mono(ENV_HELPER_EXPLICIT + decls, body));
});

test("Ex4 envelope follower behavioral: attack/release asymmetric one-pole", async () => {
  const uwk = mono(
    ENV_HELPER +
      `
const env = state.f32(0);
const aC = param.f32({default:0.5,min:0,max:1});
const rC = param.f32({default:0.05,min:0,max:1});`,
    `out.ch(0).at(i).write(envelopeFollow(input.ch(0).at(i), aC.at(i), rC.at(i), env));`,
  );
  const ATT = 0.5,
    REL = 0.05;
  const x = ramp(128, (k) => (k < 40 ? 0.8 : 0));
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
    params: { aC: [ATT], rC: [REL] },
  });
  let prev = 0;
  const ref: number[] = [];
  for (let k = 0; k < 128; k++) {
    const r = Math.abs(fr(x[k]!));
    const coef = r > prev ? ATT : REL;
    prev = fr(fr(fr(r - prev) * fr(coef)) + prev);
    ref.push(prev);
  }
  for (let k = 0; k < 128; k += 4) expect(res.outputs.main![0]![k]!).toBeCloseTo(ref[k]!, 5);
});

test("Ex4 gain reduction: `gr = e > ceil ? ceil/e : 1` ternary ≡ select", async () => {
  // `e`/`ceilingLin` are bound to `param.at(i)` (method form) so they are `Node`.
  const decls = `const cp = param.f32({default:0.5,min:0,max:1}); const ep = param.f32({default:0,min:0,max:4});`;
  const sugar = mono(
    decls,
    `const ceilingLin = cp.at(i); const e = ep.at(i);
     const gr = e > ceilingLin ? ceilingLin / e : 1;
     out.ch(0).at(i).write(input.ch(0).at(i) * gr);`,
  );
  const explicit = mono(
    decls,
    `const ceilingLin = cp.at(i); const e = ep.at(i);
     const gr = select(e.gt(ceilingLin), ceilingLin.div(e), 1);
     out.ch(0).at(i).write(input.ch(0).at(i).mul(gr));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex4 gain reduction behavioral: gr clamps signal at the ceiling", async () => {
  const uwk = mono(
    `const cp = param.f32({default:0.5,min:0,max:1});`,
    `const ceilingLin = cp.at(i);
     const e = abs(input.ch(0).at(i));
     const gr = e > ceilingLin ? ceilingLin / e : 1;
     out.ch(0).at(i).write(input.ch(0).at(i) * gr);`,
  );
  const CEIL = 0.5;
  const x = ramp(128, (k) => fr(0.1 + 0.01 * k));
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
    params: { cp: [CEIL] },
  });
  for (let k = 0; k < 128; k++) {
    const xn = fr(x[k]!);
    const e = Math.abs(xn);
    const gr = e > CEIL ? fr(CEIL / e) : 1;
    expect(res.outputs.main![0]![k]!).toBeCloseTo(fr(xn * gr), 5);
    expect(Math.abs(res.outputs.main![0]![k]!)).toBeLessThanOrEqual(CEIL + 1e-4);
  }
});

test("Ex4 ring index: `(head + i) % N` then `(wIdx.add(1)) % N` ≡ chain (delay line)", async () => {
  // `head` is a bare `State<'i32'>` (structurally DSP), so `(head + i) % N`
  // lowers. The read index keeps the `.add(1)` reachable from a `Node` (`wIdx`
  // is built by `.mod(...)` then `.add(1)`); writing `(wIdx + 1) % N` from a
  // const `wIdx` does NOT lower (recorded as a suspected bug).
  const N = 32;
  const decls = `const dly = state.buffer.f32({ size: ${N} }); const head = state.i32(0);`;
  const sugar = mono(
    decls,
    `const wIdx = (head + i) % ${N};
     dly[wIdx] = input.ch(0).at(i);
     out.ch(0).at(i).write(dly[wIdx.add(1).mod(${N})]);`,
  );
  const explicit = mono(
    decls,
    `const wIdx = head.read().add(i).mod(${N});
     dly.write(wIdx, input.ch(0).at(i));
     out.ch(0).at(i).write(dly.read(wIdx.add(1).mod(${N})));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex4 ring behavioral: a 1-sample delay-line readback shifts the signal", async () => {
  // Write x at wIdx, read at wIdx (same slot) ⇒ identity passthrough; verifies
  // the `(head + i) % N` index lowered to a real Node mod (not raw JS → NaN).
  const N = 16;
  const uwk = mono(
    `const dly = state.buffer.f32({ size: ${N} }); const head = state.i32(0);`,
    `const wIdx = (head + i) % ${N};
     dly[wIdx] = input.ch(0).at(i);
     out.ch(0).at(i).write(dly[wIdx]);
     head.write((head + ${N}) % ${N});`,
  );
  const x = ramp(128, (k) => fr(0.01 * (k + 1)));
  const res = await renderLowered(uwk, { sampleRate: SR, duration: DUR, inputs: { main: [x] } });
  for (let k = 0; k < 128; k++) expect(res.outputs.main![0]![k]!).toBeCloseTo(fr(x[k]!), 6);
});

test("Ex4 overshoot if-emit: `if (|x| > ceil) overshoot.emit(...)` ≡ emitIf", async () => {
  const decls = `
const ceiling = param.f32({ default: 0.5, min: 0, max: 1 });
const overshoot = event<{ level: number }>({ to: "main" });`;
  const sugar = mono(
    decls,
    `const ceilingLin = ceiling.at(0);
     if (abs(input.ch(0).at(i)) > ceilingLin) overshoot.emit({ atSample: i, level: abs(input.ch(0).at(i)) });
     out.ch(0).at(i).write(input.ch(0).at(i));`,
  );
  const explicit = mono(
    decls,
    `const ceilingLin = ceiling.at(0);
     overshoot.emitIf(abs(input.ch(0).at(i)).gt(ceilingLin), { atSample: i, level: abs(input.ch(0).at(i)) });
     out.ch(0).at(i).write(input.ch(0).at(i));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex4 overshoot if-emit behavioral: fires exactly on strict ceiling crossings", async () => {
  const uwk = mono(
    `
const ceiling = param.f32({ default: 0.5, min: 0, max: 1 });
const overshoot = event<{ level: number }>({ to: "main" });`,
    `const ceilingLin = ceiling.at(0);
     if (abs(input.ch(0).at(i)) > ceilingLin) overshoot.emit({ atSample: i, level: abs(input.ch(0).at(i)) });
     out.ch(0).at(i).write(input.ch(0).at(i));`,
  );
  const x = new Float32Array(128).fill(0.2);
  x[10] = 0.9;
  x[20] = 0.8;
  x[30] = 0.5; // exactly the ceiling — strict `>` must NOT fire
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
    params: { ceiling: [0.5] },
  });
  const ev = res.events.filter((e) => e.name === "overshoot");
  expect(ev.map((e) => e.atSample)).toEqual([10, 20]);
  expect((ev[0]!.payload as { level: number }).level).toBeCloseTo(0.9, 5);
});

// ════════════════════════════════════════════════════════════════════════
// Ex 5 — Granular voice pitch advance (if + buffer index + exp)
//
// `f32(activeNote - 60)` casts an i32 difference; `pos + stride` advances a
// buffered position. `pos` and `gate` here keep `Node`/method forms so the
// operator chain lowers; the bare `voicePos[v]`-into-const form does NOT lower
// (recorded). The if-write target uses the buffer-index write sugar.
// ════════════════════════════════════════════════════════════════════════

test("Ex5 voice advance: `if (input>0) voicePos[v] = pos + pitch[i]*exp(f32(an-60)*k)` ≡ select chain", async () => {
  // Inline `Node<'bool'>` condition (a `const gate = ...; if (gate)` does NOT
  // lower — the const is `boolean`-typed by stock TS; recorded).
  const decls = `
const voicePos = state.buffer.f32({ size: 4 });
const activeNote = state.i32(60);
const pitch = param.f32({ default: 1, min: 0, max: 2 });`;
  const sugar = mono(
    decls,
    `const v = 0;
     const pos = voicePos.read(v);
     if (input.ch(0).at(i) > 0) voicePos[v] = pos + pitch.at(i) * exp(f32(activeNote - 60) * (Math.LN2 / 12));
     out.ch(0).at(i).write(0);`,
  );
  const explicit = mono(
    decls,
    `const v = 0;
     const pos = voicePos.read(v);
     voicePos.write(v, select(input.ch(0).at(i).gt(0), pos.add(pitch.at(i).mul(f32(activeNote.read().sub(60)).mul(Math.LN2 / 12).exp())), voicePos.read(v)));
     out.ch(0).at(i).write(0);`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex5 behavioral: gated pitch advance writes pos+stride, ungated holds", async () => {
  const uwk = mono(
    `
const voicePos = state.buffer.f32({ size: 1 });
const activeNote = state.i32(72);
const pitch = param.f32({ default: 1, min: 0, max: 4 });`,
    `const pos = voicePos.read(0);
     if (input.ch(0).at(i) > 0) voicePos[0] = pos + pitch.at(i) * exp(f32(activeNote - 60) * (Math.LN2 / 12));
     out.ch(0).at(i).write(voicePos.read(0));`,
  );
  const x = ramp(128, (k) => (k < 64 ? 1 : 0));
  const PITCH = 1;
  const NOTE = 72;
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
    params: { pitch: [PITCH] },
  });
  const stride = fr(PITCH * fr(Math.exp(fr((NOTE - 60) * (Math.LN2 / 12)))));
  let pos = 0;
  const ref: number[] = [];
  for (let k = 0; k < 128; k++) {
    if (x[k]! > 0) pos = fr(pos + stride);
    ref.push(pos);
  }
  for (let k = 0; k < 128; k += 8) expect(res.outputs.main![0]![k]!).toBeCloseTo(ref[k]!, 2);
  expect(res.outputs.main![0]![70]!).toBeCloseTo(res.outputs.main![0]![127]!, 4);
});

test("Ex5 int diff stays int: `f32(activeNote - 60)` casts an i32 subtraction", async () => {
  const uwk = mono(
    `const activeNote = state.i32(72);`,
    `out.ch(0).at(i).write(f32(activeNote - 60) * 0.5);`,
  );
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [new Float32Array(128)] },
  });
  // (72 - 60) = 12 → f32(12) → 12 * 0.5 = 6.
  expect(res.outputs.main![0]![0]!).toBeCloseTo(6, 6);
});

// ════════════════════════════════════════════════════════════════════════
// Ex 6 — MIDI arpeggiator (if-emit, bare state)
//
// The RFC writes the output to a `midiOutput`, which is NOT in the `.uwk.ts`
// ambient set, so the MIDI-typed emit cannot be authored here. The if-emit +
// bare-state sugar it relies on is exercised against a plain numeric-payload
// `event<>`. Bare state in an emit PAYLOAD FIELD (`velocity: lastVel`) does NOT
// lower (the field's contextual type is `number`, not `Node<>`) — recorded as a
// suspected bug; the explicit `.read()` is used where a latched value is needed.
// ════════════════════════════════════════════════════════════════════════

test("Ex6 arp single emit: `if (input>0) fired.emit({...})` ≡ emitIf", async () => {
  const decls = `const fired = event<{ note: number; step: number }>({ to: "main" });`;
  const sugar = mono(
    decls,
    `const note = i32(64); const step = i32(3);
     if (input.ch(0).at(i) > 0) fired.emit({ atSample: i, note, step });
     out.ch(0).at(i).write(0);`,
  );
  const explicit = mono(
    decls,
    `const note = i32(64); const step = i32(3);
     fired.emitIf(input.ch(0).at(i).gt(0), { atSample: i, note, step });
     out.ch(0).at(i).write(0);`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex6 arp two-emit block: `if (input>0) { arpOut.emit(...); stepFired.emit(...) }` ≡ two emitIf", async () => {
  const decls = `
const arpOut = event<{ note: number; velocity: number }>({ to: "main" });
const stepFired = event<{ step: number; note: number }>({ to: "main" });`;
  const sugar = mono(
    decls,
    `const fireNote = i32(60); const nextStep = i32(0);
     if (input.ch(0).at(i) > 0) {
       arpOut.emit({ atSample: i, note: fireNote, velocity: 100 });
       stepFired.emit({ atSample: i, step: nextStep, note: fireNote });
     }
     out.ch(0).at(i).write(0);`,
  );
  const explicit = mono(
    decls,
    `const fireNote = i32(60); const nextStep = i32(0);
     arpOut.emitIf(input.ch(0).at(i).gt(0), { atSample: i, note: fireNote, velocity: 100 });
     stepFired.emitIf(input.ch(0).at(i).gt(0), { atSample: i, step: nextStep, note: fireNote });
     out.ch(0).at(i).write(0);`,
  );
  await expectSameLowering(sugar, explicit);
});

test("Ex6 arp behavioral: emits exactly on the gated samples, with explicit latched velocity", async () => {
  const uwk = mono(
    `
const lastVel = state.i32(77);
const arpOut = event<{ note: number; velocity: number }>({ to: "main" });`,
    `const fireNote = i32(64);
     if (input.ch(0).at(i) > 0) arpOut.emit({ atSample: i, note: fireNote, velocity: lastVel.read() });
     out.ch(0).at(i).write(0);`,
  );
  const x = new Float32Array(128);
  x[5] = 1;
  x[42] = 1;
  x[100] = 1;
  const res = await renderLowered(uwk, { sampleRate: SR, duration: DUR, inputs: { main: [x] } });
  const arp = res.events.filter((e) => e.name === "arpOut");
  expect(arp.map((e) => e.atSample)).toEqual([5, 42, 100]);
  for (const e of arp) {
    const p = e.payload as { note: number; velocity: number };
    expect(p.note).toBe(64);
    expect(p.velocity).toBe(77);
  }
});

// ════════════════════════════════════════════════════════════════════════
// Adversarial cross-cutting edge cases (designed to break the lowering)
// ════════════════════════════════════════════════════════════════════════

test("adversarial: `-2 * node * node` (unary lit head, two Node operands) lowers left-assoc", async () => {
  // Uses .at(i) method form so both factors are Node-typed.
  const uwk = mono(
    `const cp = param.f32({default:0,min:-1,max:1}); const vp = param.f32({default:1,min:0,max:2});`,
    `out.ch(0).at(i).write(-2 * cp.at(i) * vp.at(i));`,
  );
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [new Float32Array(128)] },
    params: { cp: [0.3], vp: [1.5] },
  });
  expect(res.outputs.main![0]![0]!).toBeCloseTo(fr(fr(fr(-2) * fr(0.3)) * fr(1.5)), 5);
});

test("adversarial: literal-lift `1 - node / node` groups as 1 - (alpha/A)", async () => {
  const uwk = mono(
    `const ap = param.f32({default:0,min:-2,max:2}); const Ap = param.f32({default:1,min:0.1,max:4});`,
    `out.ch(0).at(i).write(1 - ap.at(i) / Ap.at(i));`,
  );
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [new Float32Array(128)] },
    params: { ap: [1.5], Ap: [3] },
  });
  // 1 - 1.5/3 = 0.5, not (1-1.5)/3 = -0.1667.
  expect(res.outputs.main![0]![0]!).toBeCloseTo(fr(1 - fr(1.5 / 3)), 5);
});

test("adversarial: const-folded JS numbers (N/1, 2*1) stay JS and never lower", async () => {
  const N = 64;
  const decls = `const buf = state.buffer.f32({ size: ${N} }); const head = state.i32(0);`;
  const sugar = mono(
    decls,
    `const stride = 2 * 1; const wIdx = (head + i) % (${N} / 1);
     buf[wIdx] = input.ch(0).at(i) * stride;
     out.ch(0).at(i).write(buf[wIdx]);`,
  );
  const explicit = mono(
    decls,
    `const stride = 2 * 1; const wIdx = head.read().add(i).mod(${N} / 1);
     buf.write(wIdx, input.ch(0).at(i).mul(stride));
     out.ch(0).at(i).write(buf.read(wIdx));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("adversarial: deeply nested mixed sugar `(a+1)*(a-0.5)/2` preserves grouping", async () => {
  const uwk = mono(
    "",
    `const a = input.ch(0).at(i); out.ch(0).at(i).write((a + 1) * (a - 0.5) / 2);`,
  );
  const res = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [new Float32Array(128).fill(3)] },
  });
  // (3+1)*(3-0.5)/2 = 4*2.5/2 = 5.
  expect(res.outputs.main![0]![0]!).toBeCloseTo(fr(fr(fr(3 + 1) * fr(3 - 0.5)) / 2), 5);
});

test("adversarial: bare-state read inside `select` operands (ternary on Node cond)", async () => {
  // `s` appears in both ternary branches as a bare State — each must read.
  const decls = `const s = state.f32(0.25);`;
  const sugar = mono(
    decls,
    `s.write(input.ch(0).at(i) > 0 ? s + 1 : s - 1); out.ch(0).at(i).write(s);`,
  );
  const explicit = mono(
    decls,
    `s.write(select(input.ch(0).at(i).gt(0), s.read().add(1), s.read().sub(1))); out.ch(0).at(i).write(s.read());`,
  );
  await expectSameLowering(sugar, explicit);
});
