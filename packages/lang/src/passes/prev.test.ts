import { expect, test } from "vite-plus/test";

import { expectSameLoweredText, lower, renderLoweredText } from "../goldenHarness.ts";

const SR = 48000;
const mono = (declarations: string, value: string): string => `
${declarations}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = ${value}; }); });`;

const decayExplicit = mono(
  `const sg = defineSubgraph(() => {
  const history = state.f32(0);
  return { run: (trigger: Node<"bool">) => {
    const value = select(trigger, f32(1), history.read().mul(f32(0.95)));
    history.write(value);
    return value;
  }};
});
const s = instantiate(sg);`,
  "s.run(i == 0)",
);

test.each([
  `Node<'f32'>`,
  `Node<"f32">`,
  `Node < /* scalar */ 'f32' >`,
  `(Node<'f32'>)`,
  "Result",
  `Node<"f32"> & { readonly tag?: never }`,
  `Result & { readonly tag?: never }`,
  `{ readonly tag?: never } & Result`,
])("$prev reads the scalar from return type %s", async (annotation) => {
  const source = mono(
    `type Result = Node<'f32'>;
const sg = defineSubgraph(() => ({
  run: (trigger: Node<'bool'>): ${annotation} => trigger ? 1 : $prev * 0.95,
}));
const s = instantiate(sg);`,
    "s.run(i == 0)",
  );
  const lowered = lower(source);
  const loweredExplicit = lower(decayExplicit);
  const actual = await renderLoweredText(lowered, {
    sampleRate: SR,
    duration: 128 / SR,
  });
  await expectSameLoweredText(lowered, loweredExplicit);
  const explicit = await renderLoweredText(loweredExplicit, {
    sampleRate: SR,
    duration: 128 / SR,
  });
  expect(actual.outputs.main[0]).toEqual(explicit.outputs.main[0]);
  let value = 1;
  for (const sample of actual.outputs.main[0]!) {
    expect(sample).toBe(value);
    value = Math.fround(value * Math.fround(0.95));
  }
});

const accumulatorExplicit = mono(
  `const sg = defineSubgraph(() => {
  const history = state.f32(0);
  return { run: (x: Node<"f32">) => {
    const value = x.add(history.read());
    history.write(value);
    return value;
  }};
});
const s = instantiate(sg);`,
  "s.run(f32(1))",
);

test.each([
  `const sg = defineSubgraph(() => ({ run: (x: Node<"f32">) => { const __r = x + $prev; return __r; } }));`,
  `const sg = defineSubgraph(() => ({ run: (__r: Node<"f32">) => __r + $prev }));`,
  `const sg = defineSubgraph(() => { const __r = f32(1); return { run: () => __r + $prev }; });`,
  `const sg = defineSubgraph(() => ({ run: (x: Node<"f32">) => { const __r = x + $prev; if (true) return __r; return x; } }));`,
  `const sg = defineSubgraph(() => ({ run: (x: Node<"f32">) => { const __r = x; const __r_1 = __r + $prev; return __r_1; } }));`,
  `const sg = defineSubgraph(() => { const __prev_0 = f32(1); return { run: () => __prev_0 + $prev }; });`,
])("$prev generated bindings preserve authored identifiers: %s", async (declaration) => {
  const source = mono(`${declaration}\nconst s = instantiate(sg);`, "s.run(f32(1))");
  const lowered = lower(source);
  const loweredExplicit = lower(accumulatorExplicit);
  await expectSameLoweredText(lowered, loweredExplicit);
  const result = await renderLoweredText(lowered, {
    sampleRate: SR,
    duration: 128 / SR,
  });
  expect([...result.outputs.main[0]!]).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
});
