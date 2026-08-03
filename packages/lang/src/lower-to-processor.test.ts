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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import { loadUwkProcessor, lowerToProcessor } from "./index.ts";
import { lower } from "./lower.ts";

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

test("lowerToProcessor reports a clear error for a cross-file import (runtime-compile path)", () => {
  // The in-memory / browser runtime-compile path evaluates the lowered module via
  // `new Function`, which cannot resolve sibling files. A `.uwk.ts` that imports
  // one must fail with an actionable message, not a raw `new Function` SyntaxError.
  expect(() =>
    lowerToProcessor(
      `import { GAIN } from "./constants.ts";\n` +
        `const out = audioOutput({ channels: 1, name: "main" });\n` +
        `process(() => {\n` +
        `  forSample((i) => {\n` +
        `    out.ch(0).at(i).write(f32(GAIN));\n` +
        `  });\n` +
        `});`,
    ),
  ).toThrow(/cannot import from other files/i);
});

test("lowerToProcessor on a library module (subgraph-only) errors clearly", () => {
  // A no-process `.uwk.ts` is a library module that exports a subgraph for a
  // processor to import — it is not a processor and cannot be rendered directly.
  // The error must say so, not crash in `new Function` on the named export.
  expect(() =>
    lowerToProcessor(
      `export const onepole = defineSubgraph((coef: Node<"f32">) => ({\n` +
        `  tick: (x: Node<"f32">) => x * coef,\n` +
        `}));`,
    ),
  ).toThrow(/library module|not a processor/i);
});

test("loadUwkProcessor renders a multi-file .uwk.ts (processor + sibling subgraph)", async () => {
  // The offline / test counterpart to the Vite plugin's `?worklet` build-path
  // import: `loadUwkProcessor` writes lowered temp siblings for the entry and
  // its transitive `.uwk.ts` imports, dynamically imports the entry, and returns
  // the CompiledProcessor. Uses a subgraph in a sibling `.uwk.ts` — the exact
  // scenario the single-file runtime-compile path throws on.
  const dir = mkdtempSync(path.join(import.meta.dirname, "..", ".uwk-multifile-test-"));
  try {
    writeFileSync(
      path.join(dir, "gainStep.uwk.ts"),
      `export const gainStep = defineSubgraph((factor: Node<"f32">) => ({\n` +
        `  apply: (x: Node<"f32">) => x * factor,\n` +
        `}));`,
    );
    writeFileSync(
      path.join(dir, "main.uwk.ts"),
      `import { gainStep } from "./gainStep.uwk.ts";\n` +
        `const input = audioInput({ channels: 1, name: "main" });\n` +
        `const out = audioOutput({ channels: 1, name: "main" });\n` +
        `const g = instantiate(gainStep, f32(3));\n` +
        `process(() => {\n` +
        `  forSample((i) => {\n` +
        `    out.ch(0).at(i).write(g.apply(input.ch(0).at(i)));\n` +
        `  });\n` +
        `});`,
    );
    const proc = await loadUwkProcessor(path.join(dir, "main.uwk.ts"));
    const result = await renderOffline(proc, {
      sampleRate: 48000,
      duration: 128 / 48000,
      inputs: { main: [new Float32Array(128).fill(0.1)] },
    });
    // 0.1 × factor(3) = 0.3 — the sibling subgraph's method actually ran.
    expect(result.outputs.main[0]![64]).toBeCloseTo(0.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .uwk.ts that imports a sibling constant compiles end-to-end (build path)", async () => {
  // The build path writes the lowered module next to the source and imports it,
  // so a relative specifier resolves. Replicate that here (lower → write sibling →
  // import → render) to prove a shared constant actually reaches the compiled WASM.
  // The temp dir lives under the package so the lowered module's `@unworklet/core`
  // import resolves through this package's node_modules (a dot-prefixed name keeps
  // it out of the test-file globs).
  const dir = mkdtempSync(path.join(import.meta.dirname, "..", ".uwk-import-test-"));
  try {
    writeFileSync(path.join(dir, "constants.ts"), "export const GAIN = 3;\n");
    const lowered = lower(
      `import { GAIN } from "./constants.ts";\n` +
        `const input = audioInput({ channels: 1, name: "main" });\n` +
        `const out = audioOutput({ channels: 1, name: "main" });\n` +
        `process(() => {\n` +
        `  forSample((i) => {\n` +
        `    out.ch(0).at(i).write(input.ch(0).at(i).mul(f32(GAIN)));\n` +
        `  });\n` +
        `});`,
      { exportName: "gainer" },
    );
    const file = path.join(dir, "gainer.uwklowered.ts");
    writeFileSync(file, lowered);
    const mod = (await import(/* @vite-ignore */ file)) as {
      gainer: Parameters<typeof renderOffline>[0];
    };
    const result = await renderOffline(mod.gainer, {
      sampleRate: 48000,
      duration: 128 / 48000,
      inputs: { main: [new Float32Array(128).fill(0.1)] },
    });
    // 0.1 × GAIN(3) = 0.3 — the imported constant flowed through to the WASM.
    expect(result.outputs.main[0]![64]).toBeCloseTo(0.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
