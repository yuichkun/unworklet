/**
 * Harness validation + active bug-hunting. Each `expectSameLowering` pair asserts
 * the sugar form lowers to the same compiled processor as the explicit chain form
 * (the ground truth); each `renderLowered` checks real output against a JS
 * reference. A mismatch here is a lang bug, not a coverage gap.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "./goldenHarness.ts";

const SR = 48000;

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

test("harness: behavioral precedence — a * 2 + 0.1", async () => {
  const uwk = mono("", `out.ch(0).at(i).write(input.ch(0).at(i) * 2 + 0.1);`);
  const x = new Float32Array(128).fill(0.25);
  const r = await renderLowered(uwk, { sampleRate: SR, duration: 128 / SR, inputs: { main: [x] } });
  expect(r.outputs.main![0]![0]).toBeCloseTo(0.6, 5); // 0.25*2 + 0.1
});

test("harness: behavioral precedence — a + b * c (mul binds tighter)", async () => {
  const uwk = mono("", `out.ch(0).at(i).write(input.ch(0).at(i) + 3 * 4);`);
  const x = new Float32Array(128).fill(1);
  const r = await renderLowered(uwk, { sampleRate: SR, duration: 128 / SR, inputs: { main: [x] } });
  // build-time 3*4 stays JS = 12; 1 + 12 = 13
  expect(r.outputs.main![0]![0]).toBeCloseTo(13, 4);
});

test("BUG HUNT: buf[bareState] reads the state index (read + write)", async () => {
  const decls =
    "const buf = state.buffer.f32({ size: 8 }).named('buf');\nconst wi = state.i32(0).named('wi');";
  const sugar = mono(decls, `buf[wi] = input.ch(0).at(i);\nout.ch(0).at(i).write(buf[wi]);`);
  const explicit = mono(
    decls,
    `buf.write(wi.read(), input.ch(0).at(i));\nout.ch(0).at(i).write(buf.read(wi.read()));`,
  );
  await expectSameLowering(sugar, explicit);
});

test("BUG HUNT: bareState in a channel index — out.ch(0)[counter] / in.ch(0)[counter]", async () => {
  const decls = "const k = state.i32(0).named('k');";
  const sugar = mono(decls, `out.ch(0).at(i).write(input.ch(0)[k]);`);
  const explicit = mono(decls, `out.ch(0).at(i).write(input.ch(0).at(k.read()));`);
  await expectSameLowering(sugar, explicit);
});
