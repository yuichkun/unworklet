import { compile } from "@unworklet/core";
import { renderOffline } from "@unworklet/offline";
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

test("runtime compilation rejects authored processor exports with migration guidance", () => {
  expect(() => lowerToProcessor(`export const GAIN = 0.5;\nprocess(() => {});`)).toThrow(
    expect.objectContaining({
      id: "uwk-export-unsupported",
      message: expect.stringMatching(/separate shared module.*import/i),
    }),
  );
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

test("an enum in an already-lowered module evaluates", () => {
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

test("a namespace in an already-lowered module evaluates", () => {
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

test("named helper exports and a local export list remain usable in lowered modules", () => {
  const proc = evalLowered(`import { defineProcessor } from "@unworklet/core";
export function helper() { return 0.5; }
export class Gain { value = helper(); }
const instance = new Gain();
export { instance };
export default defineProcessor(() => ({ process() { void instance; } }));`);
  expect(proc).toHaveProperty("graph");
});

test.each(['export * from "./other.ts";', 'export { value } from "./other.ts";'])(
  "runtime evaluation reports a cross-file re-export: %s",
  (declaration) => {
    expect(() => evalLowered(`${declaration}\nexport default {};`)).toThrow(
      /cannot re-export from other files/,
    );
  },
);

test.each([
  ["named aliases", 'import { f32 as value } from "@unworklet/core";', "value(0.5)"],
  ["namespace imports", 'import * as dsp from "@unworklet/core";', "dsp.f32(0.5)"],
  ["Unicode aliases", 'import { f32 as 値 } from "@unworklet/core";', "値(0.5)"],
  ["core-name aliases", 'import { f32 as i32 } from "@unworklet/core";', "i32(0.5)"],
  ["core-name namespaces", 'import * as f32 from "@unworklet/core";', "f32.f32(0.5)"],
  [
    "multiple aliases for one export",
    'import { f32 as first, f32 as second } from "@unworklet/core";',
    "first(0.25).add(second(0.25))",
  ],
  [
    "local core-name declarations",
    "const f32 = (value: number) => value; const compile = 0.5;",
    "f32(compile)",
  ],
  [
    "nested alias shadowing",
    `import { f32 as value } from "@unworklet/core";
function half(value: number) { return value / 2; }`,
    "value(half(1))",
  ],
  [
    "type-only bindings and core side-effect imports",
    `import "@unworklet/core";
import type { Node } from "@unworklet/core";
import { type CompiledProcessor, f32 as value } from "@unworklet/core";
import type { Missing } from "./types-only.ts";
import { unused } from "./unused.ts";
const amount: number = 0.5;`,
    "value(amount)",
  ],
])(
  "evaluates %s with the imported values and renders every sample",
  async (_, declarations, value) => {
    const processor = evalLowered(`
import { audioOutput, defineProcessor, forSample } from "@unworklet/core";
${declarations}
export default defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  return { process() { forSample((i) => { out.ch(0).at(i).write(${value}); }); } };
});`);
    const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
    expect([...result.outputs.main[0]!]).toEqual(Array.from({ length: 128 }, () => 0.5));
  },
);

test.each([
  'import "./side-effect.ts";',
  'import * as other from "./other.ts"; void other;',
  'import other from "./other.ts"; void other;',
])("rejects a surviving non-core runtime import: %s", (declaration) => {
  expect(() => evalLowered(`${declaration}\nexport default {};`)).toThrow(
    /cannot import from other files/,
  );
});

test("rejects a default core import because core has no default export", () => {
  expect(() => evalLowered('import dsp from "@unworklet/core"; export default dsp;')).toThrow(
    /@unworklet\/core.*no default export/,
  );
});

test.each([false, true])(
  "lowers core aliases and namespaces to audible PCM (captured snapshot: %s)",
  async (useSnapshot) => {
    const snapshot = useSnapshot ? captureFsSnapshot() : undefined;
    for (const [declaration, value] of [
      ['import { f32 as value } from "@unworklet/core";', "value(0.5)"],
      ['import * as dsp from "@unworklet/core";', "dsp.f32(0.5)"],
    ]) {
      const processor = lowerToProcessor(
        `${declaration}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0)[i] = ${value}; }); });`,
        snapshot,
      );
      const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
      expect([...result.outputs.main[0]!]).toEqual(Array.from({ length: 128 }, () => 0.5));
    }
  },
);
