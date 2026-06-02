/**
 * Category: BUFFER INDEX (all element types).
 *
 * Exhaustive bit-identity + behavioral coverage of `state.buffer.<T>[i]` sugar:
 *   - read     `buf[i]`            → `buf.read(i)`
 *   - write    `buf[i] = v`        → `buf.write(i, v)`
 *   - every element type           (f32 / f64 / i32 / i64 / bool / u8)
 *   - every index/value position   (Node loop-counter, bare-State, operator,
 *                                   nested buffer-read, literal)
 *   - nesting / associativity / precedence
 *   - adversarial edges designed to break the index pass.
 *
 * `expectSameLowering(sugar, explicit)` proves structural identity against the
 * hand-written CHAIN-DSL ground truth (the explicit form uses NO `[i]` / operator /
 * bare-state sugar). `renderLowered` proves the SEMANTICS against a pure-JS
 * reference — the higher-confidence oracle for precedence / off-by-one / int-vs-float.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const Q = 128; // one render quantum

/** Mono `.uwk.ts`: declarations + one per-sample body. */
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

const ramp = (len = Q, start = 1, step = 1): Float32Array => {
  const a = new Float32Array(len);
  for (let n = 0; n < len; n++) a[n] = start + n * step;
  return a;
};

// ───────────────────────────────────────────────────────────────────────────
// 1. READ — `buf[i]` → `buf.read(i)`, every element type, loop-counter index
// ───────────────────────────────────────────────────────────────────────────

test("read f32: buf[i] → buf.read(i)", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[i]);`),
    mono(d, `out.ch(0).at(i).write(buf.read(i));`),
  );
});

test("read f64: buf[i] → buf.read(i)", async () => {
  const d = `const buf = state.buffer.f64({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `out.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

test("read i32: buf[i] → buf.read(i)", async () => {
  const d = `const buf = state.buffer.i32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `out.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

test("read i64: buf[i] → buf.read(i)", async () => {
  const d = `const buf = state.buffer.i64({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `out.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

test("read bool: buf[i] → buf.read(i)", async () => {
  const d = `const buf = state.buffer.bool({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(select(buf[i], 1, 0));`),
    mono(d, `out.ch(0).at(i).write(select(buf.read(i), 1, 0));`),
  );
});

test("read u8: buf[i] → buf.read(i) (read result is i32)", async () => {
  const d = `const buf = state.buffer.u8({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `out.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 2. WRITE — `buf[i] = v` → `buf.write(i, v)`, every element type
// ───────────────────────────────────────────────────────────────────────────

test("write f32 literal: buf[i] = 0.5 → buf.write(i, 0.5)", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = 0.5;\nout.ch(0).at(i).write(buf[i]);`),
    mono(d, `buf.write(i, 0.5);\nout.ch(0).at(i).write(buf.read(i));`),
  );
});

test("write f32 node: buf[i] = input.ch(0).at(i)", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = input.ch(0).at(i);\nout.ch(0).at(i).write(buf[i]);`),
    mono(d, `buf.write(i, input.ch(0).at(i));\nout.ch(0).at(i).write(buf.read(i));`),
  );
});

test("write f64: buf[i] = f64(1.5)", async () => {
  const d = `const buf = state.buffer.f64({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = f64(1.5);\nout.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `buf.write(i, f64(1.5));\nout.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

test("write i32: buf[i] = i32(7)", async () => {
  const d = `const buf = state.buffer.i32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = i32(7);\nout.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `buf.write(i, i32(7));\nout.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

test("write i64 (BigInt, no implicit lift): buf[i] = i64(3n)", async () => {
  const d = `const buf = state.buffer.i64({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = i64(3n);\nout.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `buf.write(i, i64(3n));\nout.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

test("write bool: buf[i] = bool(true)", async () => {
  const d = `const buf = state.buffer.bool({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = bool(true);\nout.ch(0).at(i).write(select(buf[i], 1, 0));`),
    mono(d, `buf.write(i, bool(true));\nout.ch(0).at(i).write(select(buf.read(i), 1, 0));`),
  );
});

test("write u8: buf[i] = i32(200) (value is i32 for u8)", async () => {
  const d = `const buf = state.buffer.u8({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = i32(200);\nout.ch(0).at(i).write(f32(buf[i]));`),
    mono(d, `buf.write(i, i32(200));\nout.ch(0).at(i).write(f32(buf.read(i)));`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 3. BARE-STATE in index / value positions (must auto-read)
// ───────────────────────────────────────────────────────────────────────────

test("bare-State index (read): buf[wi] → buf.read(wi.read())", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst wi = state.i32(0).named("wi");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[wi]);`),
    mono(d, `out.ch(0).at(i).write(buf.read(wi.read()));`),
  );
});

test("bare-State index (write): buf[wi] = v → buf.write(wi.read(), v)", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst wi = state.i32(0).named("wi");`;
  await expectSameLowering(
    mono(d, `buf[wi] = input.ch(0).at(i);`),
    mono(d, `buf.write(wi.read(), input.ch(0).at(i));`),
  );
});

test("bare-State value: buf[i] = drive → buf.write(i, drive.read())", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst drive = state.f32(2).named("drive");`;
  await expectSameLowering(mono(d, `buf[i] = drive;`), mono(d, `buf.write(i, drive.read());`));
});

test("bare-State BOTH index and value: buf[wi] = drive", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst wi = state.i32(0).named("wi");\nconst drive = state.f32(2).named("drive");`;
  await expectSameLowering(
    mono(d, `buf[wi] = drive;`),
    mono(d, `buf.write(wi.read(), drive.read());`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 4. OPERATOR index — `buf[(w+1)%N]` and friends; precedence
// ───────────────────────────────────────────────────────────────────────────

test("operator index: buf[(w + 1) % N] → buf.read(mod(add(w,1), N))", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst wi = state.i32(0).named("wi");\nconst N = 8;`;
  await expectSameLowering(
    mono(d, `const w = wi.read();\nout.ch(0).at(i).write(buf[(w + 1) % N]);`),
    mono(d, `const w = wi.read();\nout.ch(0).at(i).write(buf.read(mod(add(w, 1), N)));`),
  );
});

test("operator index with bare-State: buf[(wi + 1) % N]", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst wi = state.i32(0).named("wi");\nconst N = 8;`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[(wi + 1) % N]);`),
    mono(d, `out.ch(0).at(i).write(buf.read(mod(add(wi.read(), 1), N)));`),
  );
});

test("operator index write: buf[(wi + 1) % N] = v", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst wi = state.i32(0).named("wi");\nconst N = 8;`;
  await expectSameLowering(
    mono(d, `buf[(wi + 1) % N] = input.ch(0).at(i);`),
    mono(d, `buf.write(mod(add(wi.read(), 1), N), input.ch(0).at(i));`),
  );
});

test("index precedence: buf[wi + 1 % N] — % binds tighter than + (1%N const-folds)", async () => {
  // wi + 1 % N : `1 % N` is number%number = build-time JS (stays); only the
  // outer + lifts because wi (state) is a Node operand.
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst wi = state.i32(0).named("wi");\nconst N = 8;`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[wi + 1 % N]);`),
    mono(d, `out.ch(0).at(i).write(buf.read(add(wi.read(), 1 % N)));`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. NESTED: out.ch(0)[i] = buf[w] * g ; buffer-indexed-by-buffer
// ───────────────────────────────────────────────────────────────────────────

test("nested out write + buffer read * gain: out.ch(0)[i] = buf[w] * g", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst g = state.f32(0.5).named("g");\nconst wi = state.i32(0).named("wi");`;
  await expectSameLowering(
    mono(d, `const w = wi.read();\nout.ch(0)[i] = buf[w] * g;`),
    mono(d, `const w = wi.read();\nout.ch(0).at(i).write(mul(buf.read(w), g.read()));`),
  );
});

test("buffer indexed by buffer read: buf[idxBuf[i]]", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst idxBuf = state.buffer.i32({ size: 8 }).named("idxBuf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[idxBuf[i]]);`),
    mono(d, `out.ch(0).at(i).write(buf.read(idxBuf.read(i)));`),
  );
});

test("buffer write indexed by buffer read: buf[idxBuf[i]] = v", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst idxBuf = state.buffer.i32({ size: 8 }).named("idxBuf");`;
  await expectSameLowering(
    mono(d, `buf[idxBuf[i]] = input.ch(0).at(i);`),
    mono(d, `buf.write(idxBuf.read(i), input.ch(0).at(i));`),
  );
});

test("self-indexed buffer: buf[buf[i]]", async () => {
  const d = `const buf = state.buffer.i32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(f32(buf[buf[i]]));`),
    mono(d, `out.ch(0).at(i).write(f32(buf.read(buf.read(i))));`),
  );
});

test("buffer read in deep operator tree: buf[i]*g + buf[wi]", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst g = state.f32(0.5).named("g");\nconst wi = state.i32(0).named("wi");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[i] * g + buf[wi]);`),
    mono(d, `out.ch(0).at(i).write(add(mul(buf.read(i), g.read()), buf.read(wi.read())));`),
  );
});

test("unary neg on bare-State buffer value: buf[i] = -drive", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst drive = state.f32(2).named("drive");`;
  await expectSameLowering(
    mono(d, `buf[i] = -drive;`),
    mono(d, `buf.write(i, neg(drive.read()));`),
  );
});

test("ternary value into buffer write: buf[i] = c ? a : b", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst drive = state.f32(2).named("drive");`;
  await expectSameLowering(
    mono(d, `buf[i] = drive.read() > 1 ? drive : 0;`),
    mono(d, `buf.write(i, select(gt(drive.read(), 1), drive.read(), 0));`),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 6. BEHAVIORAL (pure-JS reference) — semantics, off-by-one, int-vs-float
// ───────────────────────────────────────────────────────────────────────────

test("BEHAVIORAL: write-then-read round-trips f32 input", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");`;
  const x = ramp(Q, 0.01, 0.01);
  const r = await renderLowered(
    mono(d, `buf[i % 8] = input.ch(0).at(i);\nout.ch(0).at(i).write(buf[i % 8]);`),
    { sampleRate: SR, duration: Q / SR, inputs: { main: [x] } },
  );
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(x[n]!, 5);
});

test("BEHAVIORAL: ring-buffer delay of D samples produces an echo", async () => {
  const D = 5;
  const d = `const buf = state.buffer.f32({ size: ${D} }).named("buf");\nconst wi = state.i32(0).named("wi");`;
  const body = `
const w = wi.read();
out.ch(0).at(i).write(buf[w]);
buf[w] = input.ch(0).at(i);
wi.write((w + 1) % ${D});
`;
  const x = ramp(Q, 1, 1);
  const r = await renderLowered(mono(d, body), {
    sampleRate: SR,
    duration: Q / SR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  // JS reference: a delay line.
  const ref = new Float32Array(Q);
  const mem = new Float32Array(D);
  let w = 0;
  for (let n = 0; n < Q; n++) {
    ref[n] = mem[w]!;
    mem[w] = x[n]!;
    w = (w + 1) % D;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 4);
});

test("BEHAVIORAL: operator index off-by-one — buf[(w+1)%D] reads NEXT slot", async () => {
  // Prove the index expression is (w+1)%D, not w or w+1 (overrun) — a delay of D-1.
  const D = 6;
  const d = `const buf = state.buffer.f32({ size: ${D} }).named("buf");\nconst wi = state.i32(0).named("wi");`;
  const body = `
const w = wi.read();
buf[w] = input.ch(0).at(i);
out.ch(0).at(i).write(buf[(w + 1) % ${D}]);
wi.write((w + 1) % ${D});
`;
  const x = ramp(Q, 1, 1);
  const r = await renderLowered(mono(d, body), {
    sampleRate: SR,
    duration: Q / SR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const ref = new Float32Array(Q);
  const mem = new Float32Array(D);
  let w = 0;
  for (let n = 0; n < Q; n++) {
    mem[w] = x[n]!;
    ref[n] = mem[(w + 1) % D]!;
    w = (w + 1) % D;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 4);
});

test("BEHAVIORAL: i32 buffer truncates fractional writes (int store)", async () => {
  // Store input*10 (e.g. 2.5 -> i32) into an i32 buffer, read back: integer truncation.
  const d = `const buf = state.buffer.i32({ size: 4 }).named("buf");`;
  const body = `
buf[i % 4] = i32(input.ch(0).at(i) * 10);
out.ch(0).at(i).write(f32(buf[i % 4]));
`;
  const x = new Float32Array(Q).fill(0.25); // *10 = 2.5 -> i32 = 2
  const r = await renderLowered(mono(d, body), {
    sampleRate: SR,
    duration: Q / SR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(2, 5);
});

test("BEHAVIORAL: u8 buffer read returns i32 value (round-trips 0..255)", async () => {
  const d = `const buf = state.buffer.u8({ size: 4 }).named("buf");\nconst v = state.i32(200).named("v");`;
  const body = `
buf[i % 4] = v;
out.ch(0).at(i).write(f32(buf[i % 4]));
`;
  const r = await renderLowered(mono(d, body), { sampleRate: SR, duration: Q / SR });
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(200, 5);
});

test("BEHAVIORAL: u8 buffer wraps values > 255 (byte store)", async () => {
  const d = `const buf = state.buffer.u8({ size: 4 }).named("buf");\nconst v = state.i32(260).named("v");`;
  const body = `
buf[i % 4] = v;
out.ch(0).at(i).write(f32(buf[i % 4]));
`;
  const r = await renderLowered(mono(d, body), { sampleRate: SR, duration: Q / SR });
  const out = r.outputs.main![0]!;
  // 260 mod 256 = 4 (a u8 byte store keeps the low 8 bits).
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(4, 5);
});

test("BEHAVIORAL: bool buffer read drives a select", async () => {
  const d = `const buf = state.buffer.bool({ size: 4 }).named("buf");`;
  const body = `
buf[i % 4] = input.ch(0).at(i) > 0;
out.ch(0).at(i).write(select(buf[i % 4], 1, -1));
`;
  const x = new Float32Array(Q);
  for (let n = 0; n < Q; n++) x[n] = n % 2 === 0 ? 0.5 : -0.5;
  const r = await renderLowered(mono(d, body), {
    sampleRate: SR,
    duration: Q / SR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(x[n]! > 0 ? 1 : -1, 5);
});

test("BEHAVIORAL: nested out.ch(0)[i] = buf[w] * g scales the delayed signal", async () => {
  const D = 3;
  const G = 0.5;
  const d = `const buf = state.buffer.f32({ size: ${D} }).named("buf");\nconst wi = state.i32(0).named("wi");\nconst g = state.f32(${G}).named("g");`;
  const body = `
const w = wi.read();
out.ch(0)[i] = buf[w] * g;
buf[w] = input.ch(0).at(i);
wi.write((w + 1) % ${D});
`;
  const x = ramp(Q, 1, 1);
  const r = await renderLowered(mono(d, body), {
    sampleRate: SR,
    duration: Q / SR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  const ref = new Float32Array(Q);
  const mem = new Float32Array(D);
  let w = 0;
  for (let n = 0; n < Q; n++) {
    ref[n] = mem[w]! * G;
    mem[w] = x[n]!;
    w = (w + 1) % D;
  }
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(ref[n]!, 4);
});

// ───────────────────────────────────────────────────────────────────────────
// 7. ADVERSARIAL — index value type, const-fold boundary, param[i]
// ───────────────────────────────────────────────────────────────────────────

test("ADVERSARIAL: pure build-time index const-folds (buf[N*2] with const N)", async () => {
  // N*2 is number*number = stays JS (a compile-time constant index), NOT lowered to mul().
  const d = `const buf = state.buffer.f32({ size: 16 }).named("buf");\nconst N = 4;`;
  await expectSameLowering(
    mono(d, `buf[N * 2] = 0.5;\nout.ch(0).at(i).write(buf[N * 2]);`),
    mono(d, `buf.write(N * 2, 0.5);\nout.ch(0).at(i).write(buf.read(N * 2));`),
  );
});

test("ADVERSARIAL: loop counter i as buffer index is NOT read-wrapped (i is a Node)", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = input.ch(0).at(i);`),
    mono(d, `buf.write(i, input.ch(0).at(i));`),
  );
});

test("ADVERSARIAL: param[i] indexes by .at(i), not .read", async () => {
  const d = `const cutoff = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" }).named("cutoff");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(cutoff[i]);`),
    mono(d, `out.ch(0).at(i).write(cutoff.at(i));`),
  );
});

test("ADVERSARIAL: input channel index sugar input.ch(0)[i] coexists with buffer", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");`;
  await expectSameLowering(
    mono(d, `buf[i] = input.ch(0)[i];\nout.ch(0)[i] = buf[i];`),
    mono(d, `buf.write(i, input.ch(0).at(i));\nout.ch(0).at(i).write(buf.read(i));`),
  );
});

test("ADVERSARIAL: buffer write value is a bare-State indexed read of another buffer", async () => {
  const d = `const a = state.buffer.f32({ size: 8 }).named("a");\nconst b = state.buffer.f32({ size: 8 }).named("b");\nconst wi = state.i32(0).named("wi");`;
  await expectSameLowering(
    mono(d, `a[wi] = b[wi];`),
    mono(d, `a.write(wi.read(), b.read(wi.read()));`),
  );
});

test("ADVERSARIAL: clamp-wrapped buffer read as index (nested math call)", async () => {
  const d = `const buf = state.buffer.f32({ size: 8 }).named("buf");\nconst idx = state.buffer.i32({ size: 8 }).named("idx");`;
  await expectSameLowering(
    mono(d, `out.ch(0).at(i).write(buf[clamp(idx[i], 0, 7)]);`),
    mono(d, `out.ch(0).at(i).write(buf.read(clamp(idx.read(i), 0, 7)));`),
  );
});

test("BEHAVIORAL: param[i] sugar reads the param default", async () => {
  const d = `const g = param.f32({ default: 0.75, min: 0, max: 1, automationRate: "a-rate" }).named("g");`;
  const body = `out.ch(0).at(i).write(input.ch(0).at(i) * g[i]);`;
  const x = new Float32Array(Q).fill(1);
  const r = await renderLowered(mono(d, body), {
    sampleRate: SR,
    duration: Q / SR,
    inputs: { main: [x] },
  });
  const out = r.outputs.main![0]!;
  for (let n = 0; n < Q; n++) expect(out[n]).toBeCloseTo(0.75, 4);
});
