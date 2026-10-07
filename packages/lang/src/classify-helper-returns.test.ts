import { expect, test } from "vite-plus/test";

import { renderLowered } from "./goldenHarness.ts";

const config = { sampleRate: 48000, duration: 128 / 48000 };
const processor = (declarations: string, body: string): string => `
const out = audioOutput({ channels: 1, name: "main" });
${declarations}
process(() => { forSample(i => { ${body} }); });
`;

test.each([
  ["if/else", "if (enabled) return x * 2; else return x * 1;", true, 2],
  ["if/else false", "if (enabled) return x * 2; else return x * 1;", false, 1],
  ["nested block", "{ if (enabled) { return x * 2; } } return 0;", true, 2],
  ["later return", "if (!enabled) return 0; return x * 2;", true, 2],
  ["switch", "switch (enabled) { case true: return x * 2; default: return x * 1; }", true, 2],
  ["try/finally", "try { return x * 2; } finally {}", true, 2],
  ["loop", "for (let n = 0; n < 1; n++) { return x * 2; } return 0;", true, 2],
] as const)(
  "helper return under %s stays DSP at the call site",
  async (_, body, enabled, value) => {
    const declarations = `function scale(x: Node<"f32">, enabled: boolean) { ${body} }`;
    const sugar = processor(declarations, `out.ch(0)[i] = scale(f32(0.5), ${enabled}) * 2;`);
    const explicit = processor(
      declarations.replaceAll("x * 2", "mul(x, 2)").replaceAll("x * 1", "mul(x, 1)"),
      `out.ch(0).at(i).write(mul(scale(f32(0.5), ${enabled}), 2));`,
    );
    const expected = await renderLowered(explicit, config);
    const actual = await renderLowered(sugar, config);
    expect(expected.outputs.main[0]).toEqual(new Float32Array(128).fill(value));
    expect(expected.diagnostics.scrubbedSamples).toBe(0);
    expect(actual.outputs).toEqual(expected.outputs);
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each([
  ["function get(flag: boolean) { if (flag) return a && b; else return a; }", 1],
  ["function get(flag: boolean) { if (flag) return a; else return b; }", 0],
] as const)("preserves the working real-State branch: %s", async (declaration, expected) => {
  const result = await renderLowered(
    processor(
      'const a = state.bool(true).named("a"); const b = state.bool(false).named("b"); ' +
        declaration,
      "out.ch(0)[i] = get(false) ? 1 : 0;",
    ),
    config,
  );
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main[0]).toEqual(new Float32Array(128).fill(expected));
});

test.each([
  "function get() { function inner() { return f32(1) * 2; } return 3; }",
  "function get() { const inner = () => f32(1) * 2; return 3; }",
  "function get() { class Inner { run() { return f32(1) * 2; } } return 3; }",
])("does not classify a nested function return as its own: %s", async (declaration) => {
  const result = await renderLowered(
    processor(
      declaration,
      'const count = get() * 2; if (typeof count !== "number") throw new Error("Expected a build-time number"); out.ch(0)[i] = f32(count);',
    ),
    config,
  );
  expect(result.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
  expect(result.diagnostics.scrubbedSamples).toBe(0);
});
