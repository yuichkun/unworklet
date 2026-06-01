/**
 * EXHAUSTIVE param-index + a-rate lowering tests.
 *
 * Category surface: `param.f32({...})` declaration + auto-name; `param[i]` index
 * sugar → `param.at(i)`; bare-`State` index on a param → `.at(s.read())`; params
 * inside operators (`input * param[i]`, both-params, nesting); multiple params;
 * precedence; a function-arg position (`clamp(..., param[i], param[i])`); ternary
 * on a param read. Behavioral `renderLowered` proves the a-rate value flows
 * per-sample (the hardest off-by-one / k-vs-a-rate bugs); `expectSameLowering`
 * pins structural identity vs an explicit `.at(...)` chain.
 *
 * The explicit (right-hand) form is the GROUND TRUTH — hand-written `.at(...)`
 * chain DSL with no index / operator / bare-state sugar.
 *
 * NOTE: a known operator-pass gap (`isDspExpr` does not recognise that an `obj[i]`
 * element access on a param / channel / buffer will lower to a `Node`) means an
 * operator whose ONLY dsp operand is written via `[i]` index sugar is NOT lowered.
 * Cases exercising that gap (e.g. `param[i] * param[i]`, `param[i] + 0.5`,
 * `param[i] > 0.5 ? ...`, `-param[i]`) are intentionally omitted here and reported
 * separately; every operator case below keeps at least one `.at(...)` / `.read()`
 * CALL operand so the operator pass fires correctly.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const N = 128; // one block

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

/** Standard a-rate f32 param decl text. */
const P = (name: string, opts = "default: 1, min: 0, max: 4"): string =>
  `const ${name} = param.f32({ ${opts}, automationRate: "a-rate" });`;

/** Run one block, return channel-0 output as a plain number[]. */
async function render1(
  uwk: string,
  params: Record<string, number[]>,
  inputCh0?: Float32Array,
): Promise<number[]> {
  const inputs = inputCh0 ? { main: [inputCh0] } : undefined;
  const r = await renderLowered(uwk, { sampleRate: SR, duration: N / SR, inputs, params });
  return Array.from(r.outputs.main![0]!);
}

/** A linear a-rate ramp [v(0)..v(127)] within [lo,hi], snapped to 1/8 (f32-clean). */
function ramp(lo: number, hi: number): number[] {
  const a = Array.from<number>({ length: N });
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    a[i] = Math.round((lo + (hi - lo) * t) * 8) / 8;
  }
  return a;
}

// ───────────────────────────────────────────────────────────────────────────
// STRUCTURAL: param[i] ≡ param.at(i), auto-name, named-wins
// ───────────────────────────────────────────────────────────────────────────

test("param[i] read ≡ param.at(i) (auto-named from const binding)", async () => {
  const decls = P("gain");
  const sugar = mono(decls, `out.ch(0).at(i).write(gain[i]);`);
  const explicit = mono(decls, `out.ch(0).at(i).write(gain.at(i));`);
  await expectSameLowering(sugar, explicit);
});

test("param[i] under a multiply (call operand on left) ≡ .at(i) chain", async () => {
  const decls = P("gain");
  const sugar = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i]);`);
  const explicit = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i).mul(gain.at(i)));`);
  await expectSameLowering(sugar, explicit);
});

test("operand order parity: gain[i] * input ≡ input * gain[i] (call on one side)", async () => {
  const decls = P("gain");
  const left = mono(decls, `out.ch(0).at(i).write(gain[i] * input.ch(0).at(i));`);
  const leftX = mono(decls, `out.ch(0).at(i).write(gain.at(i).mul(input.ch(0).at(i)));`);
  await expectSameLowering(left, leftX);
  const right = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i]);`);
  const rightX = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i).mul(gain.at(i)));`);
  await expectSameLowering(right, rightX);
});

test("explicit .named() on param wins over auto-name; [i] ≡ .at(i)", async () => {
  const decls = `const g = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("realGain");`;
  const sugar = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * g[i]);`);
  const explicit = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i).mul(g.at(i)));`);
  await expectSameLowering(sugar, explicit);
});

test("param[i] in an add with a call operand ≡ .add chain", async () => {
  const decls = P("amt");
  const sugar = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) + amt[i]);`);
  const explicit = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i).add(amt.at(i)));`);
  await expectSameLowering(sugar, explicit);
});

// ───────────────────────────────────────────────────────────────────────────
// STRUCTURAL: bare-State index on a param
// ───────────────────────────────────────────────────────────────────────────

test("param[bareState] index reads the i32 cursor state", async () => {
  const decls = `${P("gain")}\nconst k = state.i32(0).named('k');`;
  const sugar = mono(decls, `out.ch(0).at(i).write(gain[k]);`);
  const explicit = mono(decls, `out.ch(0).at(i).write(gain.at(k.read()));`);
  await expectSameLowering(sugar, explicit);
});

test("param[bareState] mixed with a call operand: gain[k] * input", async () => {
  const decls = `${P("gain")}\nconst k = state.i32(0).named('k');`;
  const sugar = mono(decls, `out.ch(0).at(i).write(gain[k] * input.ch(0).at(i));`);
  const explicit = mono(decls, `out.ch(0).at(i).write(gain.at(k.read()).mul(input.ch(0).at(i)));`);
  await expectSameLowering(sugar, explicit);
});

test("param.at(bareState) (no index sugar) still read-wraps the state", async () => {
  const decls = `${P("gain")}\nconst k = state.i32(0).named('k');`;
  const sugar = mono(decls, `out.ch(0).at(i).write(gain.at(k));`);
  const explicit = mono(decls, `out.ch(0).at(i).write(gain.at(k.read()));`);
  await expectSameLowering(sugar, explicit);
});

// ───────────────────────────────────────────────────────────────────────────
// STRUCTURAL: nesting / precedence (always one call operand present)
// ───────────────────────────────────────────────────────────────────────────

test("nested precedence: input * gain[i] + input (mul binds tighter)", async () => {
  const decls = P("gain");
  const sugar = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i] + input.ch(0).at(i));`,
  );
  const explicit = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i).mul(gain.at(i)).add(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("parenthesized regroup: (input + gain[i]) * input", async () => {
  const decls = P("gain");
  const sugar = mono(
    decls,
    `out.ch(0).at(i).write((input.ch(0).at(i) + gain[i]) * input.ch(0).at(i));`,
  );
  const explicit = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i).add(gain.at(i)).mul(input.ch(0).at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("two params both reached via a call operand: input * a[i] + input * b[i]", async () => {
  const decls = `${P("a")}\n${P("b")}`;
  const sugar = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i) * a[i] + input.ch(0).at(i) * b[i]);`,
  );
  const explicit = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i).mul(a.at(i)).add(input.ch(0).at(i).mul(b.at(i))));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("ternary with a call-operand condition gating on a param read", async () => {
  const decls = P("gate", "default: 0.5, min: 0, max: 1");
  const sugar = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i) > gate[i] ? input.ch(0).at(i) : 0);`,
  );
  const explicit = mono(
    decls,
    `out.ch(0).at(i).write(select(input.ch(0).at(i).gt(gate.at(i)), input.ch(0).at(i), 0));`,
  );
  await expectSameLowering(sugar, explicit);
});

// ───────────────────────────────────────────────────────────────────────────
// STRUCTURAL: param[i] in function-argument positions (no operator pass involved)
// ───────────────────────────────────────────────────────────────────────────

test("param[i] as clamp() args ≡ .at(i) args", async () => {
  const decls = `${P("lo", "default: 0, min: -4, max: 4")}\n${P("hi", "default: 1, min: -4, max: 4")}`;
  const sugar = mono(decls, `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo[i], hi[i]));`);
  const explicit = mono(
    decls,
    `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo.at(i), hi.at(i)));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("param[i] as min() arg ≡ .at(i) arg", async () => {
  const decls = P("ceil", "default: 1, min: 0, max: 4");
  const sugar = mono(decls, `out.ch(0).at(i).write(min(input.ch(0).at(i), ceil[i]));`);
  const explicit = mono(decls, `out.ch(0).at(i).write(min(input.ch(0).at(i), ceil.at(i)));`);
  await expectSameLowering(sugar, explicit);
});

// ───────────────────────────────────────────────────────────────────────────
// BEHAVIORAL: prove the a-rate value flows through param.at(i)
// ───────────────────────────────────────────────────────────────────────────

test("a-rate flow: out = input * gain[i], per-sample gain ramp", async () => {
  const decls = P("gain");
  const uwk = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i]);`);
  const x = new Float32Array(N).fill(1);
  const gain = ramp(0, 4);
  const got = await render1(uwk, { gain }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(gain[i]!, 5); // 1 * gain[i]
});

test("a-rate off-by-one: gain[i] reads sample i (strictly monotonic gain)", async () => {
  const decls = P("gain");
  const uwk = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i]);`);
  const x = new Float32Array(N).fill(1);
  const gain = ramp(0.5, 3.5);
  for (let i = 1; i < N; i++) if (gain[i]! <= gain[i - 1]!) gain[i] = gain[i - 1]! + 0.125;
  const got = await render1(uwk, { gain }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(gain[i]!, 5);
});

test("a-rate vs k-rate: single-element param array broadcasts to every sample", async () => {
  const decls = P("gain");
  const uwk = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i]);`);
  const x = new Float32Array(N).fill(0.25);
  const got = await render1(uwk, { gain: [2] }, x); // length 1 = broadcast 2.0
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(0.5, 5); // 0.25 * 2
});

test("param default applies when params omitted (default 1 = passthrough)", async () => {
  const decls = P("gain");
  const uwk = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i]);`);
  const x = new Float32Array(N).fill(0.3);
  const got = await render1(uwk, {}, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(0.3, 5);
});

test("a-rate short hold: 2-element param holds the last value for sample 2..127", async () => {
  const decls = P("gain");
  const uwk = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i]);`);
  const x = new Float32Array(N).fill(1);
  const got = await render1(uwk, { gain: [0.25, 0.75] }, x);
  expect(got[0]!).toBeCloseTo(0.25, 6);
  for (let i = 1; i < N; i++) expect(got[i]!).toBeCloseTo(0.75, 6);
});

test("two params drive distinct factors: out = input * a[i] + input * b[i]", async () => {
  const decls = `${P("a")}\n${P("b")}`;
  const uwk = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i) * a[i] + input.ch(0).at(i) * b[i]);`,
  );
  const x = new Float32Array(N).fill(2);
  const a = ramp(0, 3);
  const b = ramp(0.5, 1.5);
  const got = await render1(uwk, { a, b }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(2 * a[i]! + 2 * b[i]!, 4);
});

test("precedence behavioral: input * gain[i] + input (mul first)", async () => {
  const decls = P("gain");
  const uwk = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i) * gain[i] + input.ch(0).at(i));`,
  );
  const x = new Float32Array(N).fill(1);
  const gain = ramp(0, 2);
  const got = await render1(uwk, { gain }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(1 * gain[i]! + 1, 4);
});

test("precedence behavioral: (input + gain[i]) * input (add first)", async () => {
  const decls = P("gain");
  const uwk = mono(
    decls,
    `out.ch(0).at(i).write((input.ch(0).at(i) + gain[i]) * input.ch(0).at(i));`,
  );
  const x = new Float32Array(N).fill(2);
  const gain = ramp(0, 2);
  const got = await render1(uwk, { gain }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo((2 + gain[i]!) * 2, 4);
});

test("ternary behavioral: input > gate[i] ? input : 0 (per-sample gate)", async () => {
  const decls = P("gate", "default: 0.5, min: 0, max: 1");
  const uwk = mono(
    decls,
    `out.ch(0).at(i).write(input.ch(0).at(i) > gate[i] ? input.ch(0).at(i) : 0);`,
  );
  const x = new Float32Array(N).fill(0.5);
  const gate = Array.from<number>({ length: N });
  for (let i = 0; i < N; i++) gate[i] = i % 2 === 0 ? 0.25 : 0.75; // below / above input(0.5)
  const got = await render1(uwk, { gate }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(0.5 > gate[i]! ? 0.5 : 0, 6);
});

test("clamp behavioral: clamp(input, lo[i], hi[i]) per-sample bounds", async () => {
  const decls = `${P("lo", "default: 0, min: -4, max: 4")}\n${P("hi", "default: 1, min: -4, max: 4")}`;
  const uwk = mono(decls, `out.ch(0).at(i).write(clamp(input.ch(0).at(i), lo[i], hi[i]));`);
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.round((-2 + (4 * i) / (N - 1)) * 8) / 8; // -2..2
  const lo = Array.from<number>({ length: N }).fill(-1);
  const hi = Array.from<number>({ length: N }).fill(1);
  const got = await render1(uwk, { lo, hi }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(Math.min(Math.max(x[i]!, -1), 1), 5);
});

test("min behavioral: min(input, ceil[i]) limits per-sample", async () => {
  const decls = P("ceil", "default: 1, min: 0, max: 4");
  const uwk = mono(decls, `out.ch(0).at(i).write(min(input.ch(0).at(i), ceil[i]));`);
  const x = new Float32Array(N).fill(2);
  const ceil = ramp(0.5, 3.5);
  const got = await render1(uwk, { ceil }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(Math.min(2, ceil[i]!), 5);
});

test("param[bareState] cursor behavioral: gain[k] with k=0 reads gain.at(0) every sample", async () => {
  const decls = `${P("gain")}\nconst k = state.i32(0).named('k');`;
  const uwk = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(i) * gain[k]);`);
  const x = new Float32Array(N).fill(0.5);
  const gain = ramp(1, 3); // gain[0] = 1.0
  const got = await render1(uwk, { gain }, x);
  for (let i = 0; i < N; i++) expect(got[i]!).toBeCloseTo(0.5 * gain[0]!, 5);
});
