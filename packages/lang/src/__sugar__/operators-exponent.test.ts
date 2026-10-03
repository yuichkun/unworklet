/**
 * The exponent operator `**` on DSP values.
 *
 * Two oracles (see `../goldenHarness.ts`):
 *  - `expectSameLowering(sugar, explicit)` — the explicit chain form is the
 *    ground truth for what `**` lowers to.
 *  - `renderLowered(uwk, config)` — lower + eval + render, compared to the value
 *    JavaScript's `**` gives. This is what an author hears: a statement holding
 *    `**` must produce sound, never silence.
 *
 * Lowering contract exercised here:
 *  - `a ** b` → `pow(a, b)` when an operand is or lowers to a Node.
 *  - `number ** number` stays build-time JavaScript.
 *  - JavaScript precedence holds: `**` binds tighter than `*` and is
 *    right-associative.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const DUR = 128 / SR;

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

const block = (v: number): Float32Array => new Float32Array(128).fill(v);

async function render1(decls: string, body: string, x: number, params = {}): Promise<number> {
  const r = await renderLowered(mono(decls, body), {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [block(x)] },
    params,
  });
  return r.outputs.main![0]![0]!;
}

test("`x ** y` on a DSP value lowers to pow(x, y)", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0)[i] ** 2;`),
    mono("", `out.ch(0).at(i).write(pow(input.ch(0).at(i), 2));`),
  );
});

test("`number ** number` stays a build-time constant", async () => {
  await expectSameLowering(
    mono("", `out.ch(0)[i] = input.ch(0)[i] * 2 ** 3;`),
    mono("", `out.ch(0).at(i).write(mul(input.ch(0).at(i), 8));`),
  );
});

test("`**` binds tighter than `*` and is right-associative", async () => {
  const k = `const k = state.f32(2).named();`;
  await expectSameLowering(
    mono(k, `out.ch(0)[i] = 3 * input.ch(0)[i] ** k ** 2;`),
    mono(k, `out.ch(0).at(i).write(mul(3, pow(input.ch(0).at(i), pow(k.read(), 2))));`),
  );
});

test("a gain in dB, 10 ** (dB / 20), is heard at that level instead of silence", async () => {
  const decls = `const gainDb = param.f32({ default: -6, min: -60, max: 6, automationRate: "a-rate" }).named();`;
  const body = `out.ch(0)[i] = input.ch(0)[i] * 10 ** (gainDb[i] / 20);`;
  expect(await render1(decls, body, 0.5)).toBeCloseTo(0.5 * 10 ** (-6 / 20), 5);
  expect(await render1(decls, body, 0.5, { gainDb: [-20] })).toBeCloseTo(0.05, 5);
});

test("squaring a negative sample gives its positive square", async () => {
  expect(await render1("", `out.ch(0)[i] = input.ch(0)[i] ** 2;`, -0.5)).toBe(0.25);
});

test("a bare state operand is read for its value", async () => {
  const decls = `const level = state.f32(0.5).named();`;
  expect(await render1(decls, `out.ch(0)[i] = input.ch(0)[i] * level ** 2;`, 1)).toBe(0.25);
});
