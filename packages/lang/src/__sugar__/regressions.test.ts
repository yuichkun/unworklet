/**
 * Regression repros for the 20 bugs the exhaustive bug-hunt surfaced, grouped by
 * root cause. Each is the minimal case that exposed a wrong lowering (NaN, wrong
 * branch, or crash) — they must all stay green.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const cfg = (inputs?: Record<string, Float32Array[]>, params?: Record<string, number[]>) => ({
  sampleRate: SR,
  duration: 128 / SR,
  ...(inputs ? { inputs } : {}),
  ...(params ? { params } : {}),
});
const mono = (decls: string, body: string): string => `
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => { forSample((i) => { ${body} }); });
`;
const stereo = (decls: string, body: string): string => `
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
${decls}
process(() => { forSample((i) => { ${body} }); });
`;

// ─── Root A: index-read as a direct operator operand ───────────────────────
test("A1 channel index-read operand: input.ch(0)[i] * 2 + 0.1 → 0.6", async () => {
  const r = await renderLowered(
    mono("", `out.ch(0).at(i).write(input.ch(0)[i] * 2 + 0.1);`),
    cfg({ main: [new Float32Array(128).fill(0.25)] }),
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(0.6, 5);
});

test("A2 param index-read operand: a[i] * a[i] with param a=2 → 4", async () => {
  const r = await renderLowered(
    mono(
      `const a = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });`,
      `out.ch(0).at(i).write(a[i] * a[i]);`,
    ),
    cfg({ main: [new Float32Array(128)] }, { a: [2] }),
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(4, 4);
});

test("A3 Ex1 flagship: out.left[i] = input.left[i] * gain[i] (stereo) ≡ chain", async () => {
  const decls = `const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");`;
  await expectSameLowering(
    stereo(
      decls,
      `out.left[i] = input.left[i] * gain[i]; out.right[i] = input.right[i] * gain[i];`,
    ),
    stereo(
      decls,
      `out.left.at(i).write(input.left.at(i).mul(gain.at(i))); out.right.at(i).write(input.right.at(i).mul(gain.at(i)));`,
    ),
  );
});

test("A4 buffer index-read scaled by a number: buf[h] * 0.5 ≡ buf.read(h).mul(0.5)", async () => {
  const decls = `const buf = state.buffer.f32({ size: 8 }).named("buf"); const h = state.i32(0).named("h");`;
  await expectSameLowering(
    mono(decls, `const hh = h.read(); out.ch(0).at(i).write(buf[hh] * 0.5);`),
    mono(decls, `const hh = h.read(); out.ch(0).at(i).write(buf.read(hh).mul(0.5));`),
  );
});

// ─── Root B: const-binding hop / sugar-helper call / union ─────────────────
test("B1 const bound to an operator result stays DSP downstream", async () => {
  const r = await renderLowered(
    mono("", `const x = input.ch(0).at(i) * 2; out.ch(0).at(i).write(x - x * x);`),
    cfg({ main: [new Float32Array(128).fill(0.3)] }),
  );
  // x = 0.6 ; x - x*x = 0.6 - 0.36 = 0.24
  expect(r.outputs.main![0]![0]).toBeCloseTo(0.24, 5);
});

test("B2 const bound to (state+i)%N is a DSP index downstream", async () => {
  const decls = `const buf = state.buffer.f32({ size: 32 }).named("buf"); const head = state.i32(0).named("head");`;
  await expectSameLowering(
    mono(
      decls,
      `const wIdx = (head + i) % 32; buf[wIdx] = input.ch(0).at(i); out.ch(0).at(i).write(buf[(wIdx + 1) % 32]);`,
    ),
    mono(
      decls,
      `const wIdx = head.read().add(i).mod(32); buf.write(wIdx, input.ch(0).at(i)); out.ch(0).at(i).write(buf.read(wIdx.add(1).mod(32)));`,
    ),
  );
});

test("B3 sugar-bodied helper call as an operator operand lowers", async () => {
  const r = await renderLowered(
    mono(
      `const double = (v: Node<"f32">) => v * 2;`,
      `out.ch(0).at(i).write(-double(input.ch(0).at(i)));`,
    ),
    cfg({ main: [new Float32Array(128).fill(0.3)] }),
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(-0.6, 5); // -(0.3*2)
});

test("B4 pipe(x, helper) as an operator operand lowers", async () => {
  const r = await renderLowered(
    mono(
      `const double = (v: Node<"f32">) => v * 2;`,
      `out.ch(0).at(i).write(pipe(input.ch(0).at(i), double) * 0.5);`,
    ),
    cfg({ main: [new Float32Array(128).fill(0.4)] }),
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(0.4, 5); // (0.4*2)*0.5
});

test("B5 const bound to a Node|State ternary classifies as Node (no spurious .read())", async () => {
  const decls = `const hold = state.f32(0).named("hold"); const hc = state.i32(0).named("hc");`;
  await expectSameLowering(
    mono(
      decls,
      `const held = hc.read() % 8 == 0 ? input.ch(0).at(i) : hold; out.ch(0).at(i).write(held); hold.write(held);`,
    ),
    mono(
      decls,
      `const held = select(hc.read().mod(8).eq(0), input.ch(0).at(i), hold.read()); out.ch(0).at(i).write(held); hold.write(held);`,
    ),
  );
});

// ─── Root C: bare State in synthesized / JS-boolean positions ──────────────
test("C1 if-sugar reads a bare bool-State condition (single write)", async () => {
  const decls = `const c = state.bool(true).named("c"); const acc = state.f32(0).named("acc");`;
  await expectSameLowering(
    mono(decls, `if (c) acc.write(f32(1));`),
    mono(decls, `acc.write(select(c.read(), f32(1), acc.read()));`),
  );
});

test("C2 if-sugar reads a bare bool-State condition (guarded emit)", async () => {
  const decls = `const c = state.bool(true).named("c"); const ev = event({ to: "main", name: "ev" });`;
  await expectSameLowering(
    mono(decls, `if (c) ev.emit({ atSample: i });`),
    mono(decls, `ev.emitIf(c.read(), { atSample: i });`),
  );
});

test("C3 bare State as a branch of a JS-boolean ternary auto-reads", async () => {
  const decls = `const s = state.f32(0.5).named("s"); const N = 2;`;
  const r = await renderLowered(
    mono(decls, `out.ch(0).at(i).write((N > 1) ? s : 0);`),
    cfg({ main: [new Float32Array(128)] }),
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(0.5, 5);
});

test("C4 bare State in an emit-payload field auto-reads", async () => {
  const decls = `const lastVel = state.i32(100).named("lastVel"); const fired = event<{ vel: number }>({ to: "main", name: "fired" });`;
  await expectSameLowering(
    mono(decls, `if (i > -1) fired.emit({ atSample: i, vel: lastVel });`),
    mono(decls, `fired.emitIf(i.gt(-1), { atSample: i, vel: lastVel.read() });`),
  );
});

// ─── Root D: $prev structural gaps ─────────────────────────────────────────
test("D1 block-bodied subgraph method with $prev", async () => {
  const decls = `const sg = defineSubgraph((coef: Node<"f32">) => ({ run: (x: Node<"f32">) => { return coef * x + (1 - coef) * $prev; } })); const lp = instantiate(sg, f32(0.5), { name: "lp" });`;
  const r = await renderLowered(
    mono(decls, `out.ch(0).at(i).write(lp.run(input.ch(0).at(i)));`),
    cfg({ main: [new Float32Array(128).fill(1)] }),
  );
  expect(Number.isFinite(r.outputs.main![0]![10]!)).toBe(true);
  expect(r.outputs.main![0]![10]).toBeGreaterThan(0); // settling one-pole on a DC input
});

test("D2 $prev subgraph factory pre-return decls are lowered", async () => {
  const decls = `const sg = defineSubgraph((coef: Node<"f32">) => { const g = coef * 2; return { run: (x: Node<"f32">) => g * x + $prev }; }); const s = instantiate(sg, f32(0.25), { name: "s" });`;
  const r = await renderLowered(
    mono(decls, `out.ch(0).at(i).write(s.run(input.ch(0).at(i)));`),
    cfg({ main: [new Float32Array(128).fill(1)] }),
  );
  expect(Number.isFinite(r.outputs.main![0]![5]!)).toBe(true);
});

// ─── Root E: auto-name gaps ────────────────────────────────────────────────
test("E1 param.expose({name}) is not clobbered by auto-name", async () => {
  // Binding name (cutoff) ≠ exposed name (viaExpose): if auto-name wrongly appended
  // `.named("cutoff")` the two would diverge; correct behaviour leaves expose alone.
  const body = `out.ch(0).at(i).write(cutoff.at(i));`;
  await expectSameLowering(
    mono(
      `const cutoff = param.f32({ default: 1, min: 0, max: 2, automationRate: "k-rate" }).expose({ name: "viaExpose" });`,
      body,
    ),
    mono(
      `const viaExpose2 = param.f32({ default: 1, min: 0, max: 2, automationRate: "k-rate" }).expose({ name: "viaExpose" });`,
      `out.ch(0).at(i).write(viaExpose2.at(i));`,
    ),
  );
});

test("E2 audioInput with an identifier options arg keeps its options", async () => {
  await expectSameLowering(
    `const opts = { channels: 1, name: "main" }; const inA = audioInput(opts); const out = audioOutput({ channels: 1, name: "main" }); process(() => { forSample((i) => { out.ch(0).at(i).write(inA.ch(0).at(i)); }); });`,
    `const inA = audioInput({ channels: 1, name: "main" }); const out = audioOutput({ channels: 1, name: "main" }); process(() => { forSample((i) => { out.ch(0).at(i).write(inA.ch(0).at(i)); }); });`,
  );
});

test("E3 state.expose({...without name}) auto-derives the binding name", async () => {
  await expectSameLowering(
    mono(
      `const meterL = state.f32(0).expose({ snapshot: "transient", publish: { rateFps: 30 } });`,
      `meterL.write(input.ch(0).at(i).abs());`,
    ),
    mono(
      `const meterL = state.f32(0).expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } });`,
      `meterL.write(input.ch(0).at(i).abs());`,
    ),
  );
});
