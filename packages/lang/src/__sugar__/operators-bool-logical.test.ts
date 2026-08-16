/**
 * Bool-logical operator sugar (`&&` `||`) → `and(a, b)` / `or(a, b)`. Both
 * operands are always evaluated (no JS-style short-circuit) — WASM realtime
 * has no branch-free short-circuit primitive, and `select(cond, a, b)` is no
 * way around it: it picks a value and evaluates both. Nothing in the DSL skips
 * an operand, so every operand has to be safe to evaluate.
 *
 * Two oracles (like the other operator-sugar tests):
 * - `expectSameLowering(sugar, explicit)` — the `explicit` form is hand-written
 *   chain DSL, GROUND TRUTH.
 * - `renderLowered(uwk, config)` — end-to-end lower + render, verified against
 *   a pure-JS reference.
 *
 * Lowering contract:
 *   a && b → and(a, b)
 *   a || b → or(a, b)
 * TYPE-DIRECTED: lowers iff an operand is / becomes a Node. Two boolean literals
 * `true && false` stays build-time JS. A bare `State<"bool">` operand reads.
 */

import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const DUR = 128 / SR;

function stereo(decls: string, body: string): string {
  return `
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
${decls}
process(() => {
  forSample((i) => {
${body}
  });
});
`;
}

async function render1(uwk: string, left: Float32Array, right: Float32Array): Promise<number[]> {
  const r = await renderLowered(uwk, {
    sampleRate: SR,
    duration: DUR,
    inputs: { main: [left, right] },
  });
  return Array.from(r.outputs.main![0]!);
}

test("STRUCT: `a && b` lowers to `and(a, b)`", async () => {
  await expectSameLowering(
    stereo(
      "",
      `const a = input.left[i] > 0.5;
const b = input.right[i] > 0.5;
out.ch(0)[i] = a && b ? 1 : 0;`,
    ),
    stereo(
      "",
      `const a = input.left.at(i).gt(0.5);
const b = input.right.at(i).gt(0.5);
out.ch(0).at(i).write(select(and(a, b), 1, 0));`,
    ),
  );
});

test("STRUCT: `a || b` lowers to `or(a, b)`", async () => {
  await expectSameLowering(
    stereo(
      "",
      `const a = input.left[i] > 0.5;
const b = input.right[i] > 0.5;
out.ch(0)[i] = a || b ? 1 : 0;`,
    ),
    stereo(
      "",
      `const a = input.left.at(i).gt(0.5);
const b = input.right.at(i).gt(0.5);
out.ch(0).at(i).write(select(or(a, b), 1, 0));`,
    ),
  );
});

test("SEMANTIC: `a && b` outputs 1 only when both sample gates are true", async () => {
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  l[0] = 1;
  r[0] = 1;
  l[1] = 1;
  r[1] = 0;
  l[2] = 0;
  r[2] = 1;
  l[3] = 0;
  r[3] = 0;
  const got = await render1(
    stereo(
      "",
      `const a = input.left[i] > 0.5;
const b = input.right[i] > 0.5;
out.ch(0)[i] = a && b ? 1 : 0;`,
    ),
    l,
    r,
  );
  expect(got.slice(0, 4)).toEqual([1, 0, 0, 0]);
});

test("SEMANTIC: `a || b` outputs 1 when either sample gate is true", async () => {
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  l[0] = 1;
  r[0] = 1;
  l[1] = 1;
  r[1] = 0;
  l[2] = 0;
  r[2] = 1;
  l[3] = 0;
  r[3] = 0;
  const got = await render1(
    stereo(
      "",
      `const a = input.left[i] > 0.5;
const b = input.right[i] > 0.5;
out.ch(0)[i] = a || b ? 1 : 0;`,
    ),
    l,
    r,
  );
  expect(got.slice(0, 4)).toEqual([1, 1, 1, 0]);
});

test("STRUCT: bare-state operand on `&&` is read-wrapped", async () => {
  await expectSameLowering(
    stereo(
      `const s = state.bool(true).named("s");`,
      `const g = input.left[i] > 0.5;
out.ch(0)[i] = s && g ? 1 : 0;`,
    ),
    stereo(
      `const s = state.bool(true).named("s");`,
      `const g = input.left.at(i).gt(0.5);
out.ch(0).at(i).write(select(and(s.read(), g), 1, 0));`,
    ),
  );
});
