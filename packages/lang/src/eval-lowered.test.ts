import { compile } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { captureFsSnapshot } from "./capture.ts";
import { evalLowered, lowerToProcessor } from "./eval-lowered.ts";

/**
 * `evalLowered` takes an already-lowered `.ts` module and runs it. Its import-strip
 * / default-export surgery must operate on the parsed AST, not by string regex — a
 * regex false-matches an `export default` / `import ... from` inside a comment or
 * string literal in the (user-authored) body.
 */
test("ignores a decoy `export default` in a comment / string (AST surgery, not regex)", () => {
  const lowered =
    `import { audioOutput, defineProcessor } from "@unworklet/core";\n` +
    `// export default not-a-real-export\n` +
    `const label = "export default also-not-real";\n` +
    `export default defineProcessor(() => {\n` +
    `  const out = audioOutput({ channels: 1, name: "main" });\n` +
    `  return { process: () => {} };\n` +
    `});\n`;
  const proc = evalLowered(lowered);
  expect(proc).toHaveProperty("graph");
});

test("a library module (no default export) is reported as not a processor", () => {
  const lowered =
    `import { defineSubgraph } from "@unworklet/core";\n` +
    `export const onepole = defineSubgraph((coef) => ({ tick: (x) => x }));\n`;
  expect(() => evalLowered(lowered)).toThrow(/library module|not a processor/i);
});

test("a residual cross-file import is reported clearly", () => {
  const lowered =
    `import { defineProcessor, instantiate } from "@unworklet/core";\n` +
    `import { onepole } from "./onepole.uwk.ts";\n` +
    `export default defineProcessor(() => {\n` +
    `  const lpf = instantiate(onepole);\n` +
    `  return { process: () => {} };\n` +
    `});\n`;
  expect(() => evalLowered(lowered)).toThrow(/cannot import from other files/i);
});

const DISTORTION = `
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();
process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    const r = input.right[i] * drive[i];
    out.left[i]  = l > 1 ? 1 : l < -1 ? -1 : l;
    out.right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  });
});`;

test("lowering off a captured snapshot compiles to a real (non-empty) WASM", async () => {
  // `@unworklet/lang/browser` bundles exactly this captured snapshot. If the
  // snapshot is incomplete, type-directed lowering silently no-ops, the index
  // writes stay raw, the process() body is dropped, and binaryen emits an
  // 88-byte stub WASM (the "browser is silent, no error" bug). Pin a real module
  // here, compiled off-disk through the same capture → lower path.
  const proc = lowerToProcessor(DISTORTION, captureFsSnapshot());
  const { wasm } = await compile(proc);
  expect((wasm as Uint8Array).byteLength).toBeGreaterThan(200);
});

test("a processor with a module-scope export evaluates end-to-end (issue #44 repro)", () => {
  // Pre-fix, the export was swallowed into the defineProcessor callback and the
  // emitted module threw `SyntaxError: Unexpected token 'export'` at eval.
  const processor = lowerToProcessor(`
export const GAIN = 0.5;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(GAIN);
  });
});
`);
  expect(processor).toBeTruthy();
  expect(typeof processor.schemaHash).toBe("string");
});

test("options({ id }) flows through to the compiled processor's identity", () => {
  const processor = lowerToProcessor(`
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0);
  });
});
options({ id: "synth-x" });
`);
  expect(processor.id).toBe("synth-x");
});

test("a hoisted enum survives the runtime-compile path", () => {
  // The export partition hoists enums (and namespaces) to module scope, so the
  // runtime path has to turn them into something a function body can hold.
  const lowered =
    `import { audioOutput, defineProcessor, forSample } from "@unworklet/core";\n` +
    `export enum Mode { Soft = 1, Hard = 2 }\n` +
    `export default defineProcessor(() => {\n` +
    `  const out = audioOutput({ channels: 1, name: "main" });\n` +
    `  return { process: () => { forSample((i) => { out.ch(0).at(i).write(Mode.Soft / 10); }); } };\n` +
    `});\n`;
  const proc = evalLowered(lowered);
  expect(proc).toHaveProperty("graph");
  expect(typeof proc.schemaHash).toBe("string");
});

test("a hoisted namespace survives the runtime-compile path", () => {
  const lowered =
    `import { audioOutput, defineProcessor, forSample } from "@unworklet/core";\n` +
    `export namespace Tuning { export const A4 = 440; }\n` +
    `export default defineProcessor(() => {\n` +
    `  const out = audioOutput({ channels: 1, name: "main" });\n` +
    `  return { process: () => { forSample((i) => { out.ch(0).at(i).write(Tuning.A4 / 1000); }); } };\n` +
    `});\n`;
  const proc = evalLowered(lowered);
  expect(proc).toHaveProperty("graph");
  expect(typeof proc.schemaHash).toBe("string");
});
