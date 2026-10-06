import ts from "typescript";
import { expect, test } from "vite-plus/test";

import { isDspExpr } from "./classify.ts";
import { renderLowered } from "./goldenHarness.ts";
import { buildProgram } from "./program.ts";

const config = { sampleRate: 48000, duration: 128 / 48000 };
const direct = `function scale(x: Node<"f32">, again: boolean) {
  if (again) return scale(x, false) * 2;
  return x * 1;
}`;
const aliased = `function scale(x: Node<"f32">, again: boolean) {
  if (again) { const value = scale(x, false) * 2; return value; }
  return x * 1;
}`;
const mutual = `function scale(x: Node<"f32">, again: boolean) {
  if (again) return finish(x) * 2;
  return x * 1;
}
function finish(x: Node<"f32">) { return scale(x, false); }`;

test.each([
  ["forward", direct, false, true, 2],
  ["preceding", direct, true, true, 2],
  ["base case", direct, false, false, 1],
  ["aliased return", aliased, false, true, 2],
  ["mutual", mutual, false, true, 2],
] as const)(
  "finite %s recursion matches explicit DSP",
  async (_, declarations, before, again, value) => {
    const wrap = (helper: string, result: string): string => `
    const out = audioOutput({ channels: 1, name: "main" });
    ${before ? helper : ""}
    process(() => { forSample(i => { out.ch(0)[i] = ${result}; }); });
    ${before ? "" : helper}
  `;
    const sugar = wrap(declarations, `scale(f32(0.5), ${again}) * 2`);
    const explicit = wrap(
      declarations
        .replaceAll("scale(x, false) * 2", "mul(scale(x, false), 2)")
        .replaceAll("finish(x) * 2", "mul(finish(x), 2)")
        .replaceAll("x * 1", "mul(x, 1)"),
      `mul(scale(f32(0.5), ${again}), 2)`,
    );
    const expected = await renderLowered(explicit, config);
    const actual = await renderLowered(sugar, config);
    expect(expected.outputs.main[0]).toEqual(new Float32Array(128).fill(value));
    expect(expected.diagnostics.scrubbedSamples).toBe(0);
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
    expect(actual.outputs).toEqual(expected.outputs);
  },
);

test.each([
  "function first(): number { return second(); } function second(): number { return first(); } const candidate = first();",
  "const first = second; const second = first; const candidate = first;",
])("non-DSP cycles terminate classification without becoming DSP: %s", (source) => {
  const { checker, sourceFile } = buildProgram(source);
  const statement = sourceFile.statements.at(-1)! as ts.VariableStatement;
  const candidate = statement.declarationList.declarations[0]!.initializer!;
  expect(isDspExpr(checker, candidate)).toBe(false);
  expect(isDspExpr(checker, candidate)).toBe(false);
});
