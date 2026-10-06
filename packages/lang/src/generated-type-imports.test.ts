import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderOffline } from "@unworklet/offline";
import ts from "typescript";
import { expect, test } from "vite-plus/test";

import { lowerToProcessor } from "./eval-lowered.ts";
import { loadUwkProcessor } from "./index.ts";
import { lower } from "./lower.ts";
import { buildProgram } from "./program.ts";

const imports = [
  ['import type { Node as mul } from "@unworklet/core";', 'mul<"f32">'],
  ['import { type Node as mul } from "@unworklet/core";', 'mul<"f32">'],
  ['import type * as mul from "@unworklet/core";', 'mul.Node<"f32">'],
];
const config = { sampleRate: 48000, duration: 128 / 48000 };
const diagnostics = (source: string): string[] => {
  const { program, sourceFile } = buildProgram(source);
  return program
    .getSemanticDiagnostics(sourceFile)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
};

test.each(imports)(
  "type-only helper import stays valid in a lowered processor: %s",
  async (declaration, type) => {
    const source = `${declaration}
const value: ${type} = f32(0.5);
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = value * f32(2); }); });`;
    const lowered = lower(source);
    expect(lowered).toContain(declaration);
    expect(diagnostics(lowered)).toEqual([]);
    const result = await renderOffline(lowerToProcessor(source), config);
    expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(1));
  },
);

test.each(imports)(
  "type-only helper import stays valid in a lowered library: %s",
  async (declaration, type) => {
    const library = `${declaration}
export const gain = defineSubgraph(() => ({ tick: (value: ${type}) => value * f32(2) }));`;
    const lowered = lower(library);
    expect(lowered).toContain(declaration);
    expect(diagnostics(lowered)).toEqual([]);
    const directory = mkdtempSync(path.join(import.meta.dirname, "../.type-import-"));
    try {
      writeFileSync(path.join(directory, "gain.uwk.ts"), library);
      const entry = path.join(directory, "main.uwk.ts");
      writeFileSync(
        entry,
        `import { gain } from "./gain.uwk.ts";
const instance = instantiate(gain);
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = instance.tick(f32(0.5)); }); });`,
      );
      const result = await renderOffline(await loadUwkProcessor(entry), config);
      expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(1));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a genuine imported-type error survives generated helper aliasing", () => {
  const lowered = lower(`import type { Node as mul } from "@unworklet/core";
const value: mul<"f32"> = i32(1);
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = value * f32(2); }); });`);
  const errors = diagnostics(lowered);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/i32.*f32/);
});

test("an ordinary ambient call remains imported outside a helper's shadowing scope", async () => {
  const source = `const value = mul(f32(0.5), f32(2));
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => {
  const mul = 99;
  out.ch(0)[i] = value + f32(0.5) * f32(2);
}); });`;
  expect(diagnostics(lower(source))).toEqual([]);
  const result = await renderOffline(lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(2));
});

test("an explicit ambient helper call survives a same-named type-only import", async () => {
  const source = `import type { Node as mul } from "@unworklet/core";
const value: mul<"f32"> = mul(f32(0.5), f32(2));
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = value * f32(2); }); });`;
  expect(diagnostics(lower(source))).toEqual([]);
  const result = await renderOffline(lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(2));
});

test("type-only helper imports preserve value aliases, shorthand keys, methods, and local bindings", async () => {
  const source = `import type { Node as mul } from "@unworklet/core";
type Multiply = typeof mul;
const multiply: Multiply = mul;
const helpers = { mul };
const named = { mul: mul };
function local(mul: (a: number, b: number) => number) { return mul(1, 2); }
const value: mul<"f32"> = multiply(f32(0.5), f32(2)).mul(f32(2));
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => {
  out.ch(0)[i] = value * f32(2) + helpers.mul(f32(1), f32(2)) + named.mul(f32(1), f32(2)) + f32(local((a, b) => a + b));
}); });`;
  const lowered = lower(source);
  expect(lowered).toContain("{ mul:");
  expect(lowered).toContain("helpers.mul(");
  expect(lowered).toContain("named.mul(");
  expect(lowered).toContain("return mul(1, 2)");
  expect(diagnostics(lowered)).toEqual([]);
  const result = await renderOffline(lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(11));
});
