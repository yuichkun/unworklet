import { expect, test } from "vite-plus/test";

import { expectSameLowering, renderLowered } from "../goldenHarness.ts";

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
  const actual = await renderLowered(source, { sampleRate: SR, duration: 128 / SR });
  await expectSameLowering(source, decayExplicit);
  const explicit = await renderLowered(decayExplicit, { sampleRate: SR, duration: 128 / SR });
  expect(actual.outputs.main[0]).toEqual(explicit.outputs.main[0]);
  let value = 1;
  for (const sample of actual.outputs.main[0]!) {
    expect(sample).toBe(value);
    value = Math.fround(value * Math.fround(0.95));
  }
});
