/**
 * A method-call result is a DSP operand. `isDspExpr` recovers the shapes stock TS
 * mis-types as `any` — an index read (`buf[i]`), a sugar-bound local, a sugar-bodied
 * call. A method call ON one of those (`idx[i].add(1)`, `const m = idx[i].neg(); m * 2`)
 * is a fourth such shape: the receiver mis-types `any`, so the method result does too,
 * and `.add(1)`/`.neg()` can't be resolved off `any`. If the operator dispatch misses
 * it, the infix `*`/`+` stays raw JS over a `Node` → `NaN` at runtime.
 *
 * These render the lowered processor and assert real numbers — a missed desugar shows
 * up as NaN, not as a structural diff that a string match might overlook.
 */

import { expect, test } from "vite-plus/test";

import { renderLowered } from "../goldenHarness.ts";

const SR = 48000;

/** Lower + render a mono per-sample body with a constant input; return output[0][0]. */
async function firstOut(body: string, inval: number): Promise<number> {
  const src = `const input = audioInput({ channels: 1, name: "main" });
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { ${body} }); });`;
  const r = await renderLowered(src, {
    sampleRate: SR,
    duration: 128 / SR,
    inputs: { main: [new Float32Array(128).fill(inval)] },
  });
  return r.outputs.main![0]![0]!;
}

test("infix over an inline method-call result lowers (idx.add(1) * 2 = 8)", async () => {
  expect(await firstOut("out.ch(0)[i] = input.ch(0)[i].add(1) * 2;", 3)).toBeCloseTo(8, 5);
});

test("infix over a method-bound local lowers (const m = idx.neg(); m * 2 = -6)", async () => {
  expect(await firstOut("const m = input.ch(0)[i].neg(); out.ch(0)[i] = m * 2;", 3)).toBeCloseTo(
    -6,
    5,
  );
});

test("infix over a chained method result lowers (idx.add(1).neg() * 2 = -8)", async () => {
  expect(await firstOut("out.ch(0)[i] = input.ch(0)[i].add(1).neg() * 2;", 3)).toBeCloseTo(-8, 5);
});
