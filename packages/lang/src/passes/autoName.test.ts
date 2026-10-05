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

for (const item of cases) {
  test.each(["variable", "helper"])(
    `.expose derives the ${item.kind} name while preserving a nameless %s bag`,
    async (form) => {
      const options = item.options.replace(/name: "[^"]+", /, "");
      const setup =
        form === "variable"
          ? `const exposure = ${options};`
          : `const exposure = () => (${options});`;
      const arg = form === "variable" ? "exposure" : "exposure()";
      const source = mono(
        `${setup}\nconst level = ${item.declaration}.expose(${arg});`,
        item.value,
      );
      const explicit = mono(
        `const level = ${item.declaration}.expose({ name: "level", ...${options} });`,
        item.value,
      );
      await expectSameLowering(source, explicit);
      const rendered = await renderLowered(source, { sampleRate: SR, duration: 128 / SR });
      expect([...rendered.outputs.main[0]!]).toEqual(
        Array.from({ length: 128 }, () => item.expected),
      );
    },
  );
}

test(".expose evaluates helper options once and preserves inherited fields without mutating them", async () => {
  const source = mono(
    `
const calls = { count: 0 };
class Exposure {
  get snapshot() { return "transient"; }
  get publish() { return { rateFps: 30 }; }
}
const exposure = Object.freeze(new Exposure());
const options = () => { calls.count += 1; return exposure; };
const level = state.f32(0.5).expose(options());`,
    "level * calls.count",
  );
  const explicit = mono(
    `const level = state.f32(0.5).expose({ name: "level", snapshot: "transient", publish: { rateFps: 30 } });`,
    "level * 1",
  );
  await expectSameLowering(source, explicit);
  const rendered = await renderLowered(source, { sampleRate: SR, duration: 128 / SR });
  expect([...rendered.outputs.main[0]!]).toEqual(Array.from({ length: 128 }, () => 0.5));
});

test(".expose applies an explicit name without an intermediate binding-name collision", async () => {
  const source = mono(
    `
const other = state.f32(0.25).named("level");
const exposure = { name: "meter", publish: { rateFps: 30 } };
const level = state.f32(0.5).expose(exposure);`,
    "level + other",
  );
  const explicit = mono(
    `
const other = state.f32(0.25).named("level");
const level = state.f32(0.5).expose({ name: "meter", publish: { rateFps: 30 } });`,
    "level + other",
  );
  await expectSameLowering(source, explicit);
  const rendered = await renderLowered(source, { sampleRate: SR, duration: 128 / SR });
  expect([...rendered.outputs.main[0]!]).toEqual(Array.from({ length: 128 }, () => 0.75));
});

test.each([
  { declaration: 'state.named("meter").f32(0.5)', name: "meter" },
  { declaration: "state.f32(0.5).named()", name: "level" },
])(".expose retains the naming marker in $declaration", async ({ declaration, name }) => {
  const source = mono(
    `const exposure = { publish: { rateFps: 30 } };
const level = ${declaration}.expose(exposure);`,
    "level",
  );
  const explicit = mono(
    `const level = state.f32(0.5).expose({ name: "${name}", publish: { rateFps: 30 } });`,
    "level",
  );
  await expectSameLowering(source, explicit);
  const rendered = await renderLowered(source, { sampleRate: SR, duration: 128 / SR });
  expect([...rendered.outputs.main[0]!]).toEqual(Array.from({ length: 128 }, () => 0.5));
});
