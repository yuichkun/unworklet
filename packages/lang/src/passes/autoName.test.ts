import { expect, test } from "vite-plus/test";

import { evalLowered, expectSameLowering, lower, renderLowered } from "../goldenHarness.ts";

const SR = 48000;
const mono = (declarations: string, value: string): string => `
${declarations}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = ${value}; }); });`;

const cases = [
  {
    kind: "state",
    declaration: "state.f32(0.5)",
    options: `{ name: "meter", snapshot: "transient", publish: { rateFps: 30 } }`,
    value: "level",
    expected: 0.5,
  },
  {
    kind: "param",
    declaration: "param.f32({ default: 0.25, min: 0, max: 1 })",
    options: `{ name: "gain", snapshot: "transient" }`,
    value: "level[i]",
    expected: 0.25,
  },
  {
    kind: "buffer",
    declaration: "state.buffer.f32({ size: 4 })",
    options: `{ name: "history", snapshot: "persistent" }`,
    value: "level[0] + 0.75",
    expected: 0.75,
  },
];

for (const item of cases) {
  test.each(["variable", "helper"])(
    `.expose preserves ${item.kind} options from a %s`,
    async (form) => {
      const setup =
        form === "variable"
          ? `const exposure = ${item.options};`
          : `const exposure = () => (${item.options});`;
      const arg = form === "variable" ? "exposure" : "exposure()";
      const source = mono(
        `${setup}\nconst level = ${item.declaration}.expose(${arg});`,
        item.value,
      );
      const explicit = mono(
        `const level = ${item.declaration}.expose(${item.options});`,
        item.value,
      );
      await expectSameLowering(source, explicit);
      const actual = evalLowered(lower(source));
      const expected = evalLowered(lower(explicit));
      expect(actual.worklet.publishSlots).toEqual(expected.worklet.publishSlots);
      const rendered = await renderLowered(source, { sampleRate: SR, duration: 128 / SR });
      expect([...rendered.outputs.main[0]!]).toEqual(
        Array.from({ length: 128 }, () => item.expected),
      );
    },
  );
}

test(".expose leaves a nameless non-literal option bag to core", async () => {
  const source = mono(
    `const exposure = { snapshot: "transient" };
const level = state.f32(0.5).named("meter").expose(exposure);`,
    "level",
  );
  await expectSameLowering(
    source,
    mono(`const level = state.f32(0.5).expose({ name: "meter", snapshot: "transient" });`, "level"),
  );
});
