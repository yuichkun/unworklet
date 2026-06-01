/**
 * Exhaustive sugar tests for CHANNEL index access (`.uwk.ts` → `.ts` lowering).
 *
 * Surface under test (RFC-001 S5, the channel slice of the index pass):
 *   input.ch(c)[i]       → input.ch(c).at(i)          (read, InputChannelView)
 *   input.left[i]        → input.left.at(i)           (stereo read sugar)
 *   out.ch(c)[i] = v     → out.ch(c).at(i).write(v)   (write, OutputChannelView)
 *   out.left[i]  = v     → out.left.at(i).write(v)    (stereo write sugar)
 * with the index expression itself subject to the bare-state read-wrap
 * (`input.ch(0)[k]` → `input.ch(0).at(k.read())`) and operator sugar
 * (`input.ch(0)[k + 1]` → `input.ch(0).at(add(k.read(), 1))`).
 *
 * `expectSameLowering` proves structural equivalence to a hand-written explicit
 * chain form (the ground truth); `renderLowered` checks real output against a
 * pure-JS reference for the semantic claims (channel routing, off-by-one index,
 * literal-vs-Node index, bare-state read-wrap).
 *
 * One genuine lang bug found in this category was removed and reported, not
 * asserted green: a channel index-read `[i]` used as the DIRECT operand of an
 * infix / comparison / ternary operator (`input.ch(0)[i] * 2`) is not recognized
 * as a DSP expression, so the operator stays raw JS and the lowered module
 * evaluates to NaN / the wrong ternary branch. The working spelling is
 * `input.ch(0).at(i) * 2`. See the structured report.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const DUR = 128 / SR;

/** A minimal mono processor (port name "main"): declarations + a per-sample body. */
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

/** A minimal stereo processor (port name "main"). */
function stereo(decls: string, body: string): string {
  return `
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
${decls}
process(() => {
  forSample((i) => {
${body}
  });
});
`;
}

const ramp = (n = 128, f = (k: number) => k): Float32Array =>
  Float32Array.from({ length: n }, (_, k) => f(k));

// ───────────────────────────────────────────────────────────────────────────
// 1. Structural equivalence: read / write, mono / stereo, ch(c) / left / right
// ───────────────────────────────────────────────────────────────────────────

test("mono read: input.ch(0)[i] ≡ input.ch(0).at(i)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0).at(i).write(input.ch(0)[i]);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i));`),
  );
});

test("mono write: out.ch(0)[i] = v ≡ out.ch(0).at(i).write(v)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0).at(i);`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i));`),
  );
});

test("mono read+write both sugared ≡ both explicit", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0)[i];`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i));`),
  );
});

test("stereo read sugar: input.left[i] / input.right[i] ≡ .at(i)", async () => {
  await expectSameLowering(
    stereo("", `out.ch(0).at(i).write(input.left[i]); out.ch(1).at(i).write(input.right[i]);`),
    stereo(
      "",
      `out.ch(0).at(i).write(input.left.at(i)); out.ch(1).at(i).write(input.right.at(i));`,
    ),
  );
});

test("stereo write sugar: out.left[i] = v / out.right[i] = v ≡ .at(i).write(v)", async () => {
  await expectSameLowering(
    stereo("", `out.left[i] = input.left[i]; out.right[i] = input.right[i];`),
    stereo("", `out.left.at(i).write(input.left.at(i)); out.right.at(i).write(input.right.at(i));`),
  );
});

test("stereo ch(0)/ch(1) index ≡ explicit .at(i)", async () => {
  await expectSameLowering(
    stereo("", `out.ch(0)[i] = input.ch(0)[i]; out.ch(1)[i] = input.ch(1)[i];`),
    stereo(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i)); out.ch(1).at(i).write(input.ch(1).at(i));`,
    ),
  );
});

test("left[i] and ch(0)[i] lower identically (same channel, two spellings)", async () => {
  await expectSameLowering(
    stereo("", `out.left[i] = input.left[i];`),
    stereo("", `out.ch(0)[i] = input.ch(0)[i];`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Index expression variants: literal int, bare-state read, operator index
// ───────────────────────────────────────────────────────────────────────────

test("literal int index: input.ch(0)[0] / out.ch(0)[0] ≡ .at(0)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[0] = input.ch(0)[0];`),
    mono("", `out.ch(0).at(0).write(input.ch(0).at(0));`),
  );
});

test("bare-state READ index: input.ch(0)[k] ≡ input.ch(0).at(k.read())", async () => {
  const decls = "const k = state.i32(0).named('k');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(input.ch(0)[k]);`),
    mono(decls, `out.ch(0).at(i).write(input.ch(0).at(k.read()));`),
  );
});

test("bare-state WRITE index: out.ch(0)[k] = v ≡ out.ch(0).at(k.read()).write(v)", async () => {
  const decls = "const k = state.i32(0).named('k');";
  await expectSameLowering(
    mono(decls, `out.ch(0)[k] = input.ch(0)[i];`),
    mono(decls, `out.ch(0).at(k.read()).write(input.ch(0).at(i));`),
  );
});

test("operator index: input.ch(0)[k + 1] ≡ input.ch(0).at(add(k.read(), 1))", async () => {
  const decls = "const k = state.i32(0).named('k');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(input.ch(0)[k + 1]);`),
    mono(decls, `out.ch(0).at(i).write(input.ch(0).at(add(k.read(), 1)));`),
  );
});

test("operator index with modulo: input.ch(0)[(k + 1) % 4]", async () => {
  const decls = "const k = state.i32(0).named('k');";
  await expectSameLowering(
    mono(decls, `out.ch(0).at(i).write(input.ch(0)[(k + 1) % 4]);`),
    mono(decls, `out.ch(0).at(i).write(input.ch(0).at(mod(add(k.read(), 1), 4)));`),
  );
});

test("build-time index stays JS: out.ch(0)[i] = input.ch(0)[i] with const N (N*0 etc.)", async () => {
  // `const N = 0; input.ch(0)[N]` — number*number index folds to JS, no add() emitted.
  const decls = "const N = 0;";
  await expectSameLowering(
    mono(decls, `out.ch(0)[N] = input.ch(0)[N];`),
    mono(decls, `out.ch(0).at(0).write(input.ch(0).at(0));`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Value-side composition that stays SOUND (free-fn / method-chain, not infix)
// ───────────────────────────────────────────────────────────────────────────

test("write of free-fn over channel read: out.ch(0)[i] = abs(input.ch(0)[i])", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = abs(input.ch(0)[i]);`),
    mono("", `out.ch(0).at(i).write(abs(input.ch(0).at(i)));`),
  );
});

test("write of method-chain on channel read: out.ch(0)[i] = input.ch(0)[i].abs()", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0)[i].abs();`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i).abs());`),
  );
});

test("write of value that is itself a channel read: out.ch(0)[i] = input.ch(0)[i]", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0)[i];`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(i));`),
  );
});

test("write of an explicit-node operator expression (operands NOT channel-index)", async () => {
  // x is a real Node via a const binding; operator sugar fires soundly.
  await expectSameLowering(
    mono("", `const x = input.ch(0).at(i); out.ch(0)[i] = x * 2 + 0.1;`),
    mono("", `const x = input.ch(0).at(i); out.ch(0).at(i).write(add(mul(x, 2), 0.1));`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Behavioral (pure-JS reference): channel routing, off-by-one, index type
// ───────────────────────────────────────────────────────────────────────────

test("behavioral: plain copy out.ch(0)[i] = input.ch(0)[i]", async () => {
  const x = ramp(128, (k) => (k % 7) * 0.1);
  const r = await renderLowered(mono("", `out.ch(0)[i] = input.ch(0)[i];`), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  for (let k = 0; k < 128; k++) expect(out[k]).toBeCloseTo(x[k]!, 5);
});

test("behavioral: stereo channel swap via left/right sugar", async () => {
  const L = ramp(128, () => 0.3);
  const Rr = ramp(128, () => 0.7);
  const r = await renderLowered(
    stereo("", `out.left[i] = input.right[i]; out.right[i] = input.left[i];`),
    { sampleRate: SR, duration: DUR, inputs: { main: [L, Rr] } },
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(0.7, 5); // out L gets in R
  expect(r.outputs.main![1]![0]).toBeCloseTo(0.3, 5); // out R gets in L
});

test("behavioral: ch(0)/ch(1) route the same as left/right", async () => {
  const L = ramp(128, () => 0.2);
  const Rr = ramp(128, () => 0.9);
  const r = await renderLowered(
    stereo("", `out.ch(0)[i] = input.ch(1)[i]; out.ch(1)[i] = input.ch(0)[i];`),
    { sampleRate: SR, duration: DUR, inputs: { main: [L, Rr] } },
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(0.9, 5);
  expect(r.outputs.main![1]![0]).toBeCloseTo(0.2, 5);
});

test("behavioral: literal index 0 vs loop index i (input is a ramp, distinguishable)", async () => {
  const x = ramp(128, (k) => k * 0.01); // x[0]=0, x[10]=0.1, ...
  // out.ch(0)[i] = input.ch(0)[0]  → every output sample equals input[0] = 0
  const r0 = await renderLowered(mono("", `out.ch(0)[i] = input.ch(0)[0];`), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  for (let k = 0; k < 128; k++) expect(r0.outputs.main![0]![k]).toBeCloseTo(x[0]!, 5);
  // out.ch(0)[i] = input.ch(0)[i]  → output[k] = input[k] (identity)
  const ri = await renderLowered(mono("", `out.ch(0)[i] = input.ch(0)[i];`), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  for (let k = 0; k < 128; k++) expect(ri.outputs.main![0]![k]).toBeCloseTo(x[k]!, 5);
});

test("behavioral: bare-state write index (k advances) — circular write into a buffer port", async () => {
  // Write input[i] at out[i] (identity), but drive the *read* index off a state
  // counter to exercise the bare-state read-wrap in a channel index position.
  // out.ch(0)[i] = input.ch(0)[k]; k = (k + 1) % 128  → output[k] = input[k] for k in order.
  const x = ramp(128, (k) => k * 0.005);
  const decls = "const k = state.i32(0).named('k');";
  const body = `out.ch(0)[i] = input.ch(0)[k];\nk.write((k + 1) % 128);`;
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  // k starts at 0, reads input[0] at sample 0, increments → reads input[k] at sample k.
  for (let k = 0; k < 128; k++) expect(out[k]).toBeCloseTo(x[k]!, 5);
});

test("behavioral: free-fn over channel read writes correctly (abs)", async () => {
  const x = ramp(128, (k) => (k % 2 === 0 ? -0.4 : 0.4));
  const r = await renderLowered(mono("", `out.ch(0)[i] = abs(input.ch(0)[i]);`), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  for (let k = 0; k < 128; k++) expect(out[k]).toBeCloseTo(0.4, 5);
});

test("behavioral: method-chain on channel read (.neg())", async () => {
  const x = ramp(128, () => 0.25);
  const r = await renderLowered(mono("", `out.ch(0)[i] = input.ch(0)[i].neg();`), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [x] },
  });
  expect(r.outputs.main![0]![0]).toBeCloseTo(-0.25, 5);
});

test("behavioral: write a build-time constant via channel index (no input dependency)", async () => {
  const r = await renderLowered(mono("", `out.ch(0)[i] = 0.5;`), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [ramp(128, () => 1)] },
  });
  for (let k = 0; k < 128; k++) expect(r.outputs.main![0]![k]).toBeCloseTo(0.5, 5);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Adversarial structural edges
// ───────────────────────────────────────────────────────────────────────────

test("nested channel index as the index of another (input.ch(0)[ input.ch(0)[i] ] — unusual but legal shape)", async () => {
  // The inner index-read is itself a channel read; both should desugar.
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0)[ input.ch(0)[i].abs() ];`),
    mono("", `out.ch(0).at(i).write(input.ch(0).at(input.ch(0).at(i).abs()));`),
  );
});

test("write index AND read index both bare-state-derived (read-wrap on both sides)", async () => {
  // Both the write target's index (k) and the value's read index (k) are a bare
  // State, exercising the index-pass read-wrap on the LHS index and the RHS index
  // in one statement. `.read()` is written explicitly on the value's `.mul` arg so
  // this stays inside the channel-index category (not the bare-state-in-arg case).
  const decls = "const k = state.i32(0).named('k');\nconst g = state.f32(0.5).named('g');";
  await expectSameLowering(
    mono(decls, `out.ch(0)[k] = input.ch(0)[k].mul(g.read());`),
    mono(decls, `out.ch(0).at(k.read()).write(input.ch(0).at(k.read()).mul(g.read()));`),
  );
});

test("ch(c) with a build-time-folded channel arg (ch(0 + 0) stays a number arg, not lowered)", async () => {
  // 0 + 0 is number+number → const-folds in JS, ch() receives a plain number.
  await expectSameLowering(
    stereo("", `out.ch(0 + 0)[i] = input.ch(1 + 0)[i];`),
    stereo("", `out.ch(0 + 0).at(i).write(input.ch(1 + 0).at(i));`),
  );
});

test("two writes to the same channel in one body (last write wins) lower independently", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0)[i]; out.ch(0)[i] = input.ch(0)[i].neg();`),
    mono(
      "",
      `out.ch(0).at(i).write(input.ch(0).at(i)); out.ch(0).at(i).write(input.ch(0).at(i).neg());`,
    ),
  );
});

test("behavioral: last-write-wins semantics through the sugar", async () => {
  const x = ramp(128, () => 0.6);
  const r = await renderLowered(
    mono("", `out.ch(0)[i] = input.ch(0)[i]; out.ch(0)[i] = input.ch(0)[i].neg();`),
    { sampleRate: SR, duration: DUR, inputs: { main: [x] } },
  );
  expect(r.outputs.main![0]![0]).toBeCloseTo(-0.6, 5); // second write wins
});
