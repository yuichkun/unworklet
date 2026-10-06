import { audioInput, audioOutput, defineProcessor, f32, forSample } from "@unworklet/core";
import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import { lowerToProcessor } from "./eval-lowered.ts";
import { lower } from "./lower.ts";

const source = `const id = 0;
options({ id: "osc" });
process(() => { forSample(i => { out.left[i] = 0; out.right[i] = 0; }); });`;

const explicit = defineProcessor(
  () => {
    audioInput({ channels: 2, name: "input" });
    const out = audioOutput({ channels: 2, name: "out" });
    return {
      process() {
        forSample((i) => {
          out.ch(0).at(i).write(f32(0));
          out.ch(1).at(i).write(f32(0));
        });
      },
    };
  },
  { id: "osc" },
);

test("options property keys lower independently of processor-body names", () => {
  expect(lower(source)).toContain('id: "osc"');
});

test("options property keys capture the same graph as the explicit DSL", () => {
  const processor = lowerToProcessor(source);
  expect(processor.graph).toEqual(explicit.graph);
  expect(processor.id).toBe(explicit.id);
});

test("options property keys render the same native WASM samples as the explicit DSL", async () => {
  const config = { sampleRate: 48000, duration: 128 / 48000 };
  const expected = await renderOffline(explicit, config);
  const actual = await renderOffline(lowerToProcessor(source), config);
  expect(actual.outputs).toEqual(expected.outputs);
  expect([...actual.outputs.out[0]!]).toEqual(Array(128).fill(0));
  expect([...actual.outputs.out[1]!]).toEqual(Array(128).fill(0));
});

test.each([
  ["property access name", 'options({ id: ({ id: "osc" }).id });'],
  ["optional property access name", 'options({ id: ({ id: "osc" })?.id });'],
  ["method name", 'options({ id: ({ id() { return "osc"; } }).id() });'],
  ["getter name", 'options({ get id() { return "osc"; } });'],
  ["callback parameter", 'options({ id: ((id) => id)("osc") });'],
  ["callback-local shorthand", 'options((() => { const id = "osc"; return { id }; })());'],
  [
    "callback-local computed key",
    'options((() => { const id = "id"; return { [id]: "osc" }; })());',
  ],
  ["destructuring key", 'options({ id: (({ id: name }) => name)({ id: "osc" }) });'],
  ["destructuring binding", 'options({ id: (({ id }) => id)({ id: "osc" }) });'],
  ["array binding", 'options({ id: (([id]) => id)(["osc"]) });'],
  ["named function expression", "options({ id: (function id() { return id.name; })() });"],
  [
    "function declaration",
    'options({ id: (() => { function id() { return "osc"; } return id(); })() });',
  ],
  ["class expression", 'options({ id: new (class id { value = "osc"; })().value });'],
  [
    "catch binding",
    'options({ id: (() => { try { throw "osc"; } catch (id) { return id; } })() });',
  ],
  ["block binding", 'options({ id: (() => { { const id = "osc"; return id; } })() });'],
  ["function-scoped binding", 'options({ id: (() => { { var id = "osc"; } return id; })() });'],
  ["loop binding", 'options({ id: (() => { for (const id of ["osc"]) return id; })() });'],
  ["type-only reference", 'options({ id: "osc" as typeof id });'],
  ["migration callback parameter", "migrations([{ to: 1, migrate: (id) => id }]);"],
  ["migration property name", "migrations([{ to: 1, migrate: (h) => h.id }]);"],
])("options and migrations preserve %s", (_name, macro) => {
  expect(() => lower(`const id = "body"; ${macro} process(() => {});`)).not.toThrow();
});

test.each([
  ["direct value", "options({ id });"],
  ["property value", "options({ id: id });"],
  ["computed property key", 'options({ [id]: "osc" });'],
  ["computed method name", 'options({ [id]() { return "osc"; } });'],
  ["property access receiver", "options({ id: id.value });"],
  ["element access index", 'options({ id: ["osc"][id] });'],
  ["spread value", "options({ ...id });"],
  ["callback capture", "options({ id: (() => id)() });"],
  ["parameter default", "options({ id: ((name = id) => name)() });"],
  ["destructuring default", "options({ id: (({ name = id }) => name)({}) });"],
  [
    "shorthand assignment default",
    "options((() => { let name; ({ name = id } = {}); return { id: name }; })());",
  ],
  ["runtime typeof", "options({ id: typeof id });"],
  ["migration capture", "migrations([{ to: 1, migrate: () => id }]);"],
])("options and migrations reject an inaccessible %s", (_name, macro) => {
  expect(() => lower(`const id = "body"; ${macro} process(() => {});`)).toThrow(
    expect.objectContaining({ id: "uwk-options-binding" }),
  );
});

test("options preserve imported aliases independently of processor-body names", () => {
  const lowered = lower(`import { id as externalId } from "./identity.ts";
const id = "body";
options({ id: externalId });
process(() => {});`);
  expect(lowered).toContain('import { id as externalId } from "./identity.ts"');
  expect(lowered).toContain("id: externalId");
});

test("options reject captures even when another callback shadows the same name", () => {
  expect(() =>
    lower(`const id = "body";
options({ id: ((id) => id)("osc"), version: (() => id)() });
process(() => {});`),
  ).toThrow(expect.objectContaining({ id: "uwk-options-binding" }));
});

test("options reject module-scoped var captures from nested statements", () => {
  expect(() => lower(`{ var id = "body"; } options({ id }); process(() => {});`)).toThrow(
    expect.objectContaining({ id: "uwk-options-binding" }),
  );
});

test("only the emitted options and migrations arguments are checked", () => {
  expect(() =>
    lower(`const id = "body";
options({ id }); options({ id: "osc" });
migrations(id); migrations([]);
process(() => {});`),
  ).not.toThrow();
});

test("options reject runtime heritage and generic instantiation captures", () => {
  expect(() =>
    lower(`class Base {}
options({ id: new (class extends Base {})().constructor.name });
process(() => {});`),
  ).toThrow(expect.objectContaining({ id: "uwk-options-binding" }));
  expect(() =>
    lower(`function identity<T>(value: T) { return value; }
options({ id: (identity<string>)("osc") });
process(() => {});`),
  ).toThrow(expect.objectContaining({ id: "uwk-options-binding" }));
});

test("options ignore erased heritage references", () => {
  expect(() =>
    lower(`class Base {}
options({ id: (() => {
  interface Shape extends Base {}
  class Identity implements Base {}
  return "osc";
})() });
process(() => {});`),
  ).not.toThrow();
});
