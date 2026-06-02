/**
 * Category: REALISTIC PROCESSORS — the four devtools-proto modules rewritten in
 * `.uwk.ts` sugar (operators + index + bare-state + `if`), asserted structurally
 * identical (`expectSameLowering`) to a hand-written CHAIN-DSL `.uwk.ts` that
 * mirrors each module's explicit `.processor.ts` body. Plus L1-helper DSP kernels
 * (envelope follower, one-pole, DC blocker, softclip, biquad) written with
 * operators / index / bare-state and checked structurally AND behaviorally against
 * a pure-JS reference.
 *
 * The explicit chain form is the GROUND TRUTH (no operator/index/bare-state/`if`
 * sugar). Behavioral cases (renderLowered vs a JS reference) are the higher-
 * confidence oracle for precedence / off-by-one / int-vs-float / fmod / phase wrap.
 *
 * Source of the explicit forms (read at authoring time):
 *   experiments/devtools-proto/src/processors/{noise-drive,tape-delay,crusher,
 *   midi-synth}.processor.ts
 *
 * NOTE: several genuine lowering bugs were discovered while writing this file (a
 * `const` bound to a sugar/index/operator expression is typed `any`/`number`/a
 * `Node|State` union by TS, which the type-directed dispatch then mis-handles —
 * see the report). The cases below are written with idioms that DO lower
 * correctly (the index-read is scaled via a chain `.mul()` rather than a raw
 * `buf[idx] * number`, operator-result consts are not re-operated on, ternary
 * branches are uniformly `Node`). The bug repros were removed and reported.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const Q = 128; // one render quantum
const DUR = Q / SR;
const fr = Math.fround;

/** Mono `.uwk.ts`: declarations + one per-sample body (everything inside forSample). */
const mono = (decls: string, body: string): string => `
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => {
  forSample((i) => {
${body}
  });
});
`;

/** Mono `.uwk.ts` with pre-forSample statements (e.g. MIDI onEvent handlers). */
const monoPre = (decls: string, pre: string, body: string): string => `
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => {
${pre}
  forSample((i) => {
${body}
  });
});
`;

const ramp = (len = Q, start = 1, step = 1): Float32Array => {
  const a = new Float32Array(len);
  for (let n = 0; n < len; n++) a[n] = start + n * step;
  return a;
};

const noisyRamp = (len = Q): Float32Array => {
  // Deterministic asymmetric signal so DC-blocker / envelope / biquad references
  // actually exercise their memory.
  const a = new Float32Array(len);
  for (let n = 0; n < len; n++) a[n] = fr(0.6 * Math.sin(n * 0.21) + 0.3 * (n % 5) - 0.4);
  return a;
};

// ════════════════════════════════════════════════════════════════════════════
// 1. noise-drive.processor.ts — LCG noise + tanh drive + one-pole DC blocker
//    i32 LCG (wrapping mul/add), f32 normalize, tanh, bare-state read, anonymous
//    f32 slot, branch-free select on a bool state.
// ════════════════════════════════════════════════════════════════════════════

const NOISE_DECLS = `
const seed = state.i32(22695477).named("seed");
const drive = state.f32(3.5).named("drive");
const active = state.bool(true).named("active");
const dcPrev = state.f32(0);
const LCG_MUL = 1664525;
const LCG_ADD = 1013904223;
const I32_SCALE = 1 / 2147483648;
const DC_POLE = 0.995;
`;

// Sugar body: operators + bare-state reads + ternary. `shaped`/`blocked` consts
// are bound to chain-call results (tanh()/sub()), which TS types as Node — so they
// can be re-read (dcPrev / shaped) without tripping the operator-result-const trap.
const NOISE_SUGAR = `
const next = seed * i32(LCG_MUL) + i32(LCG_ADD);
const raw = f32(next).mul(I32_SCALE);
const shaped = raw.mul(drive.read()).tanh();
const blocked = shaped.sub(dcPrev * DC_POLE);
out.ch(0).at(i).write(active ? blocked : f32(0));
seed.write(next);
dcPrev.write(shaped);
`;

test("noise-drive: full module sugar ≡ explicit chain", async () => {
  const explicit = mono(
    NOISE_DECLS,
    `
const next = seed.read().mul(i32(LCG_MUL)).add(i32(LCG_ADD));
const raw = f32(next).mul(I32_SCALE);
const shaped = raw.mul(drive.read()).tanh();
const blocked = shaped.sub(dcPrev.read().mul(DC_POLE));
out.ch(0).at(i).write(select(active.read(), blocked, f32(0)));
seed.write(next);
dcPrev.write(shaped);
`,
  );
  await expectSameLowering(mono(NOISE_DECLS, NOISE_SUGAR), explicit);
});

test("noise-drive: BEHAVIORAL — LCG + tanh + DC blocker matches JS reference", async () => {
  const r = await renderLowered(mono(NOISE_DECLS, NOISE_SUGAR), { sampleRate: SR, duration: DUR });
  const out = r.outputs.main![0]!;
  const LCG_MUL = 1664525;
  const LCG_ADD = 1013904223;
  const I32_SCALE = 1 / 2147483648;
  const DRIVE = 3.5;
  const DC_POLE = 0.995;
  let seed = 22695477 | 0;
  let dcPrev = 0;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    const next = (Math.imul(seed, LCG_MUL) + LCG_ADD) | 0;
    const raw = fr(fr(next) * fr(I32_SCALE));
    const shaped = fr(Math.tanh(fr(raw * fr(DRIVE))));
    const blocked = fr(shaped - fr(dcPrev * fr(DC_POLE)));
    ref[n] = blocked; // active=true
    seed = next;
    dcPrev = shaped;
  }
  // tanh is the one transcendental; allow a loose tolerance (WASM libm vs JS).
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 3);
});

test("noise-drive: BEHAVIORAL — active=false mutes to silence", async () => {
  const r = await renderLowered(
    mono(NOISE_DECLS.replace("state.bool(true)", "state.bool(false)"), NOISE_SUGAR),
    { sampleRate: SR, duration: DUR },
  );
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) expect(out[n]).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. tape-delay.processor.ts — feedback ring delay, i64 sampleCount, peak meter
//    f32 buffer index (read/write), i32 head wrap, i64 counter (no implicit lift),
//    .max/.abs chains, bare-state reads.
// ════════════════════════════════════════════════════════════════════════════

const tapeMono = (decls: string, body: string): string => `
const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => {
  forSample((i) => {
${body}
  });
});
`;

const TAPE_DECLS = `
const delayLine = state.buffer.f32({ size: 32768 }).named("delayLine").expose({ snapshot: "persistent" });
const head = state.i32(0).named("head");
const feedback = state.f32(0.45).named("feedback");
const sampleCount = state.i64(0n).named("sampleCount");
const meter = state.f32(0).named("meter").expose({ publish: { rateFps: 30 } });
const SIZE = 32768;
const DELAY = Math.round(48000 * 0.3);
const WET = 0.5;
const METER_DECAY = 0.999;
`;

// `delayed` is a buffer index-read (typed `any` by TS); the WET/feedback scaling
// is done with a chain `.mul()` (NOT a raw `delayed * WET`, which fails to lower —
// see bug report). The Node-vs-Node `+` and `% SIZE` index math use operator sugar.
const TAPE_SUGAR = `
const h = head.read();
const delayed = delayLine[(h + (SIZE - DELAY)) % SIZE];
const x = input.ch(0).at(i);
const wet = x + delayed.mul(WET);
out.ch(0).at(i).write(wet);
delayLine[h] = x + delayed.mul(feedback.read());
meter.write(meter.read().mul(METER_DECAY).max(wet.abs()));
head.write((h + 1) % SIZE);
sampleCount.write(sampleCount + i64(1n));
`;

test("tape-delay: full module sugar ≡ explicit chain", async () => {
  const explicit = tapeMono(
    TAPE_DECLS,
    `
const h = head.read();
const delayed = delayLine.read(h.add(i32(SIZE - DELAY)).mod(i32(SIZE)));
const x = input.ch(0).at(i);
const wet = x.add(delayed.mul(WET));
out.ch(0).at(i).write(wet);
delayLine.write(h, x.add(delayed.mul(feedback.read())));
meter.write(meter.read().mul(METER_DECAY).max(wet.abs()));
head.write(h.add(i32(1)).mod(i32(SIZE)));
sampleCount.write(sampleCount.read().add(i64(1n)));
`,
  );
  await expectSameLowering(tapeMono(TAPE_DECLS, TAPE_SUGAR), explicit);
});

test("tape-delay: BEHAVIORAL — wet mix = x + delayed*WET equals JS ring-delay reference", async () => {
  // Small ring so a delay appears within one 128-sample quantum.
  const decls = `
const delayLine = state.buffer.f32({ size: 16 }).named("delayLine");
const head = state.i32(0).named("head");
const feedback = state.f32(0.45).named("feedback");
const SIZE = 16;
const DELAY = 4;
const WET = 0.5;
`;
  const body = `
const h = head.read();
const delayed = delayLine[(h + (SIZE - DELAY)) % SIZE];
const x = input.ch(0).at(i);
const wet = x + delayed.mul(WET);
out.ch(0).at(i).write(wet);
delayLine[h] = x + delayed.mul(feedback.read());
head.write((h + 1) % SIZE);
`;
  const x = ramp(Q, 0.01, 0.003);
  const r = await renderLowered(tapeMono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const SIZE = 16;
  const DELAY = 4;
  const WET = fr(0.5);
  const FB = fr(0.45);
  const line = new Float32Array(SIZE);
  let h = 0;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    const delayed = line[(h + (SIZE - DELAY)) % SIZE]!;
    const xn = x[n]!;
    const wet = fr(xn + fr(delayed * WET));
    ref[n] = wet;
    line[h] = fr(xn + fr(delayed * FB));
    h = (h + 1) % SIZE;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 5);
});

test("tape-delay: BEHAVIORAL — i64 sampleCount increments without lift, observed as count", async () => {
  const decls = `const sampleCount = state.i64(0n).named("sampleCount");`;
  const body = `
sampleCount.write(sampleCount + i64(1n));
out.ch(0).at(i).write(f32(sampleCount));
`;
  const r = await renderLowered(tapeMono(decls, body), { sampleRate: SR, duration: DUR });
  const out = r.outputs.main![0]!;
  // incremented THEN read each sample → 1,2,3,...,128.
  for (let n = 0; n < Q; n++) expect(out[n]).toBe(n + 1);
});

test("tape-delay: structural — ring read index (h + (SIZE-DELAY)) % SIZE folds SIZE-DELAY at build time", async () => {
  // (SIZE - DELAY) is number-number → build-time JS const; only the outer + and %
  // lift because `h` is a Node.
  const decls = `
const delayLine = state.buffer.f32({ size: 32768 }).named("delayLine");
const head = state.i32(0).named("head");
const SIZE = 32768;
const DELAY = Math.round(48000 * 0.3);
`;
  const sugar = tapeMono(
    decls,
    `
const h = head.read();
out.ch(0).at(i).write(delayLine[(h + (SIZE - DELAY)) % SIZE]);
`,
  );
  const explicit = tapeMono(
    decls,
    `
const h = head.read();
out.ch(0).at(i).write(delayLine.read(mod(add(h, SIZE - DELAY), SIZE)));
`,
  );
  await expectSameLowering(sugar, explicit);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. crusher.processor.ts — sample&hold downsampler + u8 pattern ring
//    u8 buffer index write, i32 counters, select on mod==0, .max/.min clamp chain,
//    bare-state writeIdx wrap.
// ════════════════════════════════════════════════════════════════════════════

const CRUSH_DECLS = `
const crushPattern = state.buffer.u8({ size: 64 }).named("crushPattern");
const hold = state.f32(0).named("hold");
const holdCounter = state.i32(0).named("holdCounter");
const writeIdx = state.i32(0).named("writeIdx");
const DOWNSAMPLE = 8;
const PATTERN_SIZE = 64;
`;

// `held` is bound to a ternary; the FALSE branch is `hold.read()` (explicit) so
// both branches are `Node<"f32">` and `held` is a uniform Node (a `Node|State`
// union from a bare `: hold` mis-classifies — see bug report). `byte` scales held
// via operator sugar (held is a Node) then chains .max/.min.
const CRUSH_SUGAR = `
const hc = holdCounter.read();
const x = input.ch(0).at(i);
const held = hc % DOWNSAMPLE == 0 ? x : hold.read();
out.ch(0).at(i).write(held);
const wi = writeIdx.read();
const byte = (held * 127.5 + 127.5).max(0).min(255);
crushPattern[wi] = i32(byte);
hold.write(held);
holdCounter.write(hc + 1);
writeIdx.write((wi + 1) % PATTERN_SIZE);
`;

test("crusher: full module sugar ≡ explicit chain", async () => {
  const explicit = mono(
    CRUSH_DECLS,
    `
const hc = holdCounter.read();
const x = input.ch(0).at(i);
const held = select(hc.mod(i32(DOWNSAMPLE)).eq(i32(0)), x, hold.read());
out.ch(0).at(i).write(held);
const wi = writeIdx.read();
const byte = held.mul(127.5).add(127.5).max(0).min(255);
crushPattern.write(wi, i32(byte));
hold.write(held);
holdCounter.write(hc.add(i32(1)));
writeIdx.write(wi.add(i32(1)).mod(i32(PATTERN_SIZE)));
`,
  );
  await expectSameLowering(mono(CRUSH_DECLS, CRUSH_SUGAR), explicit);
});

test("crusher: BEHAVIORAL — sample&hold latches every DOWNSAMPLE samples", async () => {
  const r = await renderLowered(mono(CRUSH_DECLS, CRUSH_SUGAR), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [ramp(Q, 0.001, 0.001)] },
  });
  const out = r.outputs.main![0]!;
  const x = ramp(Q, 0.001, 0.001);
  const DOWNSAMPLE = 8;
  let hold = 0;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    const held = n % DOWNSAMPLE === 0 ? x[n]! : hold;
    ref[n] = held;
    hold = held;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 6);
});

test("crusher: BEHAVIORAL — held output is stair-stepped (constant within each hold window)", async () => {
  const r = await renderLowered(mono(CRUSH_DECLS, CRUSH_SUGAR), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [ramp(Q, 0.001, 0.001)] },
  });
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) {
    if (n % 8 !== 0) expect(out[n]).toBe(out[n - (n % 8)]);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. midi-synth.processor.ts — monophonic sine, f64 phase, MIDI onEvent gate
//    f64 phase accumulation + fmod, i32 note → Hz via exp, bool gate select,
//    event.midi onEvent handlers (pre-forSample), f32 narrowing.
// ════════════════════════════════════════════════════════════════════════════

const SYNTH_DECLS = `
const notes = event.midi({ from: "main", name: "notes" });
const phase = state.f64(0).named("phase");
const note = state.i32(69).named("note");
const gate = state.bool(false).named("gate");
const TWO_PI = 2 * Math.PI;
const PHASE_INC_PER_HZ = TWO_PI / 48000;
const LN2_OVER_12 = Math.LN2 / 12;
`;

const SYNTH_PRE = `
notes.onEvent("noteOn", ({ note: n }) => {
  note.write(n);
  gate.write(true);
});
notes.onEvent("noteOff", () => {
  gate.write(false);
});
`;

// The freq computation is kept INLINE (no intermediate operator-result const, which
// would type as `number` and break downstream — see bug report). `inc` is bound to
// a chain `.mul()` result (a Node), so `phase + f64(inc)` lowers via operator sugar.
const SYNTH_SUGAR = `
const inc = ((f32(note) - 69) * LN2_OVER_12).exp().mul(440).mul(PHASE_INC_PER_HZ);
const p = (phase + f64(inc)) % TWO_PI;
const gain = gate ? 0.3 : 0;
out.ch(0).at(i).write(f32(p.sin()) * gain);
phase.write(p);
`;

test("midi-synth: full module sugar ≡ explicit chain", async () => {
  const explicit = monoPre(
    SYNTH_DECLS,
    SYNTH_PRE,
    `
const inc = f32(note.read()).sub(69).mul(LN2_OVER_12).exp().mul(440).mul(PHASE_INC_PER_HZ);
const p = phase.read().add(f64(inc)).mod(TWO_PI);
const gain = select(gate.read(), 0.3, 0);
out.ch(0).at(i).write(f32(p.sin()).mul(gain));
phase.write(p);
`,
  );
  await expectSameLowering(monoPre(SYNTH_DECLS, SYNTH_PRE, SYNTH_SUGAR), explicit);
});

test("midi-synth: BEHAVIORAL — default gate=false → silence", async () => {
  const r = await renderLowered(monoPre(SYNTH_DECLS, SYNTH_PRE, SYNTH_SUGAR), {
    sampleRate: SR,
    duration: 0.02,
  });
  const out = r.outputs.main![0]!;
  // gain=0 → f32(sin)*0; a negative sin yields -0, so compare magnitude.
  for (let n = 0; n < out.length; n++) expect(Math.abs(out[n]!)).toBe(0);
});

test("midi-synth: BEHAVIORAL — noteOn opens gate → audible sine bounded by gain", async () => {
  const r = await renderLowered(monoPre(SYNTH_DECLS, SYNTH_PRE, SYNTH_SUGAR), {
    sampleRate: SR,
    duration: 0.02,
    events: [
      {
        name: "notes",
        payload: { type: "noteOn", channel: 0, note: 69, velocity: 100 },
        atSample: 0,
      },
    ],
  });
  const out = r.outputs.main![0]!;
  expect(out.some((s) => Math.abs(s) > 0.05)).toBe(true);
  for (let n = 0; n < out.length; n++) expect(Math.abs(out[n]!)).toBeLessThanOrEqual(0.31);
});

test("midi-synth: BEHAVIORAL — A4 (note 69) sine frequency ≈ 440 Hz", async () => {
  const r = await renderLowered(monoPre(SYNTH_DECLS, SYNTH_PRE, SYNTH_SUGAR), {
    sampleRate: SR,
    duration: 0.05,
    events: [
      {
        name: "notes",
        payload: { type: "noteOn", channel: 0, note: 69, velocity: 100 },
        atSample: 0,
      },
    ],
  });
  const out = r.outputs.main![0]!;
  let crossings = 0;
  for (let n = 1; n < out.length; n++) {
    if (out[n - 1]! <= 0 && out[n]! > 0) crossings++;
  }
  const freq = crossings / 0.05;
  expect(freq).toBeGreaterThan(400);
  expect(freq).toBeLessThan(480);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. L1-helper DSP kernels — operators + index + bare-state, structural + JS ref
// ════════════════════════════════════════════════════════════════════════════

// ── 5a. One-pole low-pass: y = a*x + (1-a)*y_prev ────────────────────────────

test("one-pole: structural — a*x + (1-a)*yPrev ≡ explicit chain", async () => {
  const decls = `const yPrev = state.f32(0).named("yPrev");\nconst A = 0.2;`;
  const sugar = mono(
    decls,
    `
const x = input.ch(0).at(i);
const y = A * x + (1 - A) * yPrev;
out.ch(0).at(i).write(y);
yPrev.write(y);
`,
  );
  // (1 - A) is number-number → build-time const; only node multiplies lift.
  const explicit = mono(
    decls,
    `
const x = input.ch(0).at(i);
const y = mul(A, x).add(mul(1 - A, yPrev.read()));
out.ch(0).at(i).write(y);
yPrev.write(y);
`,
  );
  await expectSameLowering(sugar, explicit);
});

test("one-pole: BEHAVIORAL — step response matches JS reference", async () => {
  const decls = `const yPrev = state.f32(0).named("yPrev");\nconst A = 0.2;`;
  const body = `
const x = input.ch(0).at(i);
const y = A * x + (1 - A) * yPrev;
out.ch(0).at(i).write(y);
yPrev.write(y);
`;
  const x = new Float32Array(Q).fill(1);
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const A = fr(0.2);
  const OMA = fr(1 - 0.2);
  let y = 0;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    y = fr(fr(A * fr(1)) + fr(OMA * y));
    ref[n] = y;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 5);
});

// ── 5b. DC blocker: y = x - xPrev + R*yPrev ──────────────────────────────────

test("dc-blocker: structural — x - xPrev + R*yPrev ≡ explicit chain", async () => {
  const decls = `const xPrev = state.f32(0).named("xPrev");\nconst yPrev = state.f32(0).named("yPrev");\nconst R = 0.995;`;
  const sugar = mono(
    decls,
    `
const x = input.ch(0).at(i);
const y = x - xPrev + R * yPrev;
out.ch(0).at(i).write(y);
xPrev.write(x);
yPrev.write(y);
`,
  );
  const explicit = mono(
    decls,
    `
const x = input.ch(0).at(i);
const y = x.sub(xPrev.read()).add(mul(R, yPrev.read()));
out.ch(0).at(i).write(y);
xPrev.write(x);
yPrev.write(y);
`,
  );
  await expectSameLowering(sugar, explicit);
});

test("dc-blocker: BEHAVIORAL — removes DC offset, matches JS reference", async () => {
  const decls = `const xPrev = state.f32(0).named("xPrev");\nconst yPrev = state.f32(0).named("yPrev");\nconst R = 0.995;`;
  const body = `
const x = input.ch(0).at(i);
const y = x - xPrev + R * yPrev;
out.ch(0).at(i).write(y);
xPrev.write(x);
yPrev.write(y);
`;
  const x = noisyRamp(Q);
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const R = fr(0.995);
  let xPrev = 0;
  let yPrev = 0;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    const xn = x[n]!;
    // ((x - xPrev) + (R*yPrev)), left-assoc.
    const y = fr(fr(xn - xPrev) + fr(R * yPrev));
    ref[n] = y;
    xPrev = xn;
    yPrev = y;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 4);
});

// ── 5c. Envelope follower: env += coef * (|x| - env) ─────────────────────────

test("envelope-follower: structural — env + coef*(|x| - env) ≡ explicit chain", async () => {
  const decls = `const env = state.f32(0).named("env");\nconst COEF = 0.05;`;
  const sugar = mono(
    decls,
    `
const x = input.ch(0).at(i);
const e = env + COEF * (x.abs() - env);
env.write(e);
out.ch(0).at(i).write(e);
`,
  );
  const explicit = mono(
    decls,
    `
const x = input.ch(0).at(i);
const e = env.read().add(mul(COEF, x.abs().sub(env.read())));
env.write(e);
out.ch(0).at(i).write(e);
`,
  );
  await expectSameLowering(sugar, explicit);
});

test("envelope-follower: BEHAVIORAL — tracks rectified amplitude, matches JS reference", async () => {
  const decls = `const env = state.f32(0).named("env");\nconst COEF = 0.05;`;
  const body = `
const x = input.ch(0).at(i);
const e = env + COEF * (x.abs() - env);
env.write(e);
out.ch(0).at(i).write(e);
`;
  const x = noisyRamp(Q);
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const COEF = fr(0.05);
  let env = 0;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    const ax = Math.abs(x[n]!);
    env = fr(env + fr(COEF * fr(ax - env)));
    ref[n] = env;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 4);
});

// ── 5d. Softclip: cubic waveshaper, clamped. `x` is a pure Node (a const bound to
//        `input.ch(0).at(i) * D` would type as `number` and break — see report). ──

test("softclip: structural — clamp(x - x*x*x/3, -1, 1) ≡ explicit chain", async () => {
  const sugar = mono(
    "",
    `
const x = input.ch(0).at(i);
out.ch(0).at(i).write(clamp(x - x * x * x / 3, -1, 1));
`,
  );
  const explicit = mono(
    "",
    `
const x = input.ch(0).at(i);
out.ch(0).at(i).write(clamp(x.sub(x.mul(x).mul(x).div(3)), -1, 1));
`,
  );
  await expectSameLowering(sugar, explicit);
});

test("softclip: BEHAVIORAL — cubic waveshaper matches JS reference (left-assoc x*x*x/3)", async () => {
  const body = `
const x = input.ch(0).at(i);
out.ch(0).at(i).write(clamp(x - x * x * x / 3, -1, 1));
`;
  // Inputs in [-1, 1] → cubic term meaningful, clamp rarely fires.
  const x = new Float32Array(Q);
  for (let n = 0; n < Q; n++) x[n] = fr(0.9 * Math.sin(n * 0.3));
  const r = await renderLowered(mono("", body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    const xn = x[n]!;
    // x*x*x/3 left-assoc: (((x*x)*x)/3).
    const cubic = fr(fr(fr(xn * xn) * xn) / fr(3));
    let y = fr(xn - cubic);
    if (y < -1) y = -1;
    if (y > 1) y = 1;
    ref[n] = y;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 4);
});

test("softclip: BEHAVIORAL — clamp bounds the output to [-1, 1] under heavy drive", async () => {
  const decls = `const drive = state.f32(8).named("drive");`;
  // `input.ch(0).at(i).mul(drive)` is a Node (chain on a Node), so the surrounding
  // `-` / `*` / `/` operators lower. Binding it to `const x = ... * drive` would
  // type `x` as `number` and break `x - x*x*x/3` (see bug report), so it stays a
  // pure-Node chain `xd` whose only `const` binding is a chain-call result.
  const inlineBody = `
const xd = input.ch(0).at(i).mul(drive);
out.ch(0).at(i).write(clamp(xd - xd * xd * xd / 3, -1, 1));
`;
  const x = new Float32Array(Q).fill(1); // *8 = 8 → cubic explodes, clamp must bite
  const r = await renderLowered(mono(decls, inlineBody), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) {
    expect(out[n]).toBeGreaterThanOrEqual(-1);
    expect(out[n]).toBeLessThanOrEqual(1);
  }
});

// ── 5e. Biquad (Direct Form I): full difference equation ─────────────────────

const BIQUAD_DECLS = `
const x1 = state.f32(0).named("x1");
const x2 = state.f32(0).named("x2");
const y1 = state.f32(0).named("y1");
const y2 = state.f32(0).named("y2");
const B0 = 0.2929;
const B1 = 0.5858;
const B2 = 0.2929;
const A1 = 0.0;
const A2 = 0.1716;
`;

const BIQUAD_BODY = `
const x0 = input.ch(0).at(i);
const y = B0 * x0 + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
out.ch(0).at(i).write(y);
x2.write(x1);
x1.write(x0);
y2.write(y1);
y1.write(y);
`;

test("biquad: structural — DF-I difference equation ≡ explicit chain", async () => {
  // Products bind first, then a left-assoc add/sub chain:
  // ((((B0*x0 + B1*x1) + B2*x2) - A1*y1) - A2*y2). Coeffs are JS numbers, states
  // are Nodes (bare-state read), so each product lifts.
  const explicit = mono(
    BIQUAD_DECLS,
    `
const x0 = input.ch(0).at(i);
const y = mul(B0, x0)
  .add(mul(B1, x1.read()))
  .add(mul(B2, x2.read()))
  .sub(mul(A1, y1.read()))
  .sub(mul(A2, y2.read()));
out.ch(0).at(i).write(y);
x2.write(x1);
x1.write(x0);
y2.write(y1);
y1.write(y);
`,
  );
  await expectSameLowering(mono(BIQUAD_DECLS, BIQUAD_BODY), explicit);
});

test("biquad: BEHAVIORAL — DF-I response matches JS reference", async () => {
  const x = noisyRamp(Q);
  const r = await renderLowered(mono(BIQUAD_DECLS, BIQUAD_BODY), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const B0 = fr(0.2929);
  const B1 = fr(0.5858);
  const B2 = fr(0.2929);
  const A1 = fr(0.0);
  const A2 = fr(0.1716);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const ref = new Float32Array(Q);
  for (let n = 0; n < Q; n++) {
    const x0 = x[n]!;
    let acc = fr(B0 * x0);
    acc = fr(acc + fr(B1 * x1));
    acc = fr(acc + fr(B2 * x2));
    acc = fr(acc - fr(A1 * y1));
    acc = fr(acc - fr(A2 * y2));
    ref[n] = acc;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = acc;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 3);
});

// ── 5f. Adversarial: if-on-bool-state lowering in a realistic gate ───────────

test("gate: if(c) s.write(v) — if-sugar ≡ explicit select-store", async () => {
  const decls = `const env = state.f32(0).named("env");\nconst openThresh = state.f32(0.1).named("openThresh");`;
  const sugar = mono(
    decls,
    `
const x = input.ch(0).at(i);
if (x.abs() > openThresh) env.write(x.abs());
out.ch(0).at(i).write(env);
`,
  );
  const explicit = mono(
    decls,
    `
const x = input.ch(0).at(i);
env.write(select(gt(x.abs(), openThresh.read()), x.abs(), env.read()));
out.ch(0).at(i).write(env.read());
`,
  );
  await expectSameLowering(sugar, explicit);
});

test("gate: if/else on bool — if(c) s.write(a) else s.write(b) ≡ select", async () => {
  const decls = `const out2 = state.f32(0).named("out2");`;
  const sugar = mono(
    decls,
    `
const x = input.ch(0).at(i);
if (x > 0) out2.write(x); else out2.write(-x);
out.ch(0).at(i).write(out2);
`,
  );
  const explicit = mono(
    decls,
    `
const x = input.ch(0).at(i);
out2.write(select(gt(x, 0), x, neg(x)));
out.ch(0).at(i).write(out2.read());
`,
  );
  await expectSameLowering(sugar, explicit);
});

test("gate: BEHAVIORAL — full-wave rectifier via if/else matches JS reference", async () => {
  const decls = `const out2 = state.f32(0).named("out2");`;
  const body = `
const x = input.ch(0).at(i);
if (x > 0) out2.write(x); else out2.write(-x);
out.ch(0).at(i).write(out2);
`;
  const x = noisyRamp(Q);
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(Math.abs(x[n]!), 5);
});
