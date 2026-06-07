/**
 * `lowerToProcessor` (the root, Node entry) lowers a `.uwk.ts` source straight to
 * a `CompiledProcessor` that `@unworklet/offline` renders — no Vite plugin, no
 * build step, no browser. This is the headless authoring path: write sugar, test
 * it with `renderOffline`.
 *
 * The assertion is behavioral on purpose. Lowering is type-driven (it rewrites
 * `a * b` to `a.mul(b)` only when an operand is a `Node`), so a broken type
 * resolution doesn't error — it silently lowers nothing, and the processor comes
 * out a no-op. Checking that the gain is actually applied (input × 2) is what
 * proves the lowering ran, not just that it returned a processor.
 */

import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import { lowerToProcessor } from "./index.ts";

test("lowerToProcessor renders a .uwk.ts offline with the sugar actually lowered", async () => {
  const proc = lowerToProcessor(`const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
process(() => {
  forSample((i) => {
    out.left[i] = input.left[i] * 2;
    out.right[i] = input.right[i] * 2;
  });
});`);

  const left = new Float32Array(128).fill(0.25);
  const right = new Float32Array(128).fill(-0.5);
  const result = await renderOffline(proc, {
    sampleRate: 48000,
    duration: 128 / 48000, // one 128-sample block
    inputs: { main: [left, right] },
  });

  // gain ×2 applied across the block — a no-op lowering would echo the input.
  expect(result.outputs.main[0]![64]).toBeCloseTo(0.5);
  expect(result.outputs.main[1]![64]).toBeCloseTo(-1.0);
});
