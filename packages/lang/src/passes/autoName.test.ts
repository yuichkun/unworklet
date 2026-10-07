import ts from "typescript";
import { expect, test } from "vite-plus/test";
import { lowerToProcessor } from "../eval-lowered.ts";
import { lower } from "../lower.ts";
import { buildProgram } from "../program.ts";
import { createAutoNameDeclaration } from "./autoName.ts";

function evaluate(source: string): unknown {
  const { program, sourceFile: sf } = buildProgram(source);
  const autoNameDeclaration = createAutoNameDeclaration(program);
  const transformed = ts.factory.updateSourceFile(
    sf,
    sf.statements.map((stmt) => autoNameDeclaration(stmt)),
  );
  const code = ts.createPrinter().printFile(transformed);
  return new Function(ts.transpileModule(code, {}).outputText)();
}

const processor = (declarations: string) => `${declarations}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = 0; }); });`;

for (const [kind, declaration, options] of [
  ["state", "state.f32(0.5)", '{ snapshot: "transient", publish: { rateFps: 30 } }'],
  [
    "param",
    'param.f32({ default: 1, min: 0, max: 2, automationRate: "k-rate" })',
    '{ snapshot: "transient" }',
  ],
  ["buffer", "state.buffer.f32({ size: 4 })", '{ snapshot: "transient" }'],
] as const) {
  for (const explicit of [false, true]) {
    for (const helper of [false, true]) {
      test(`${kind} preserves ${explicit ? "explicit" : "inferred"} name and ${helper ? "helper" : "variable"} options`, () => {
        const value = explicit ? `{ ...${options}, name: "meter" }` : options;
        const name = explicit ? "meter" : "level";
        const actual = lowerToProcessor(
          processor(`
const exposure = ${value};
const getOptions = () => exposure;
const level = ${declaration}.expose(${helper ? "getOptions()" : "exposure"});`),
        );
        const expected = lowerToProcessor(
          processor(`const level = ${declaration}.expose({ ...${options}, name: "${name}" });`),
        );
        expect(actual.graph).toEqual(expected.graph);
        expect(actual.worklet.publishSlots).toEqual(expected.worklet.publishSlots);
        expect(actual.worklet.parameterDescriptors).toEqual(expected.worklet.parameterDescriptors);
        expect(actual.schemaHash).toBe(expected.schemaHash);
      });
    }
  }
}

test("preserves receiver, evaluation order, inherited getters, and repeated reads", () => {
  expect(
    evaluate(`
const log = [];
const options = Object.create({
  get name() { log.push(this === options ? "name" : "wrong receiver"); return undefined; },
  get snapshot() { log.push(this === options ? "snapshot" : "wrong receiver"); return "transient"; },
  get publish() { log.push(this === options ? "publish" : "wrong receiver"); return { rateFps: 30 }; },
  get unused() { throw Error("unused getter"); }
});
const target: import("@unworklet/core").State<"f32"> = {
  get expose() {
    log.push("method");
    return function(o, extra) {
      log.push(this === target ? "receiver" : "wrong receiver");
      log.push(o.name, o.name, o.snapshot, o.publish.rateFps);
      return this;
    };
  }
};
function receiver() { log.push("receiver expression"); return target; }
function getOptions() { log.push("argument"); return options; }
function extra() { log.push("extra argument"); }
const level = receiver().expose(getOptions(), extra());
return log;
`),
  ).toEqual([
    "receiver expression",
    "method",
    "argument",
    "extra argument",
    "receiver",
    "name",
    "name",
    "snapshot",
    "publish",
    "level",
    "level",
    "transient",
    30,
  ]);
});

for (const name of ["undefined", "null", '""', '"meter"']) {
  test(`name ${name} uses only undefined as the fallback`, () => {
    expect(
      evaluate(`
const options = Object.freeze({ name: ${name} });
const target: import("@unworklet/core").State<"f32"> = { expose(o) { return o.name; } };
const level = target.expose(options);
return level;
`),
    ).toBe(name === "undefined" ? "level" : JSON.parse(name));
  });
}

test("does not eagerly read options ignored by the receiver or capture authored names", () => {
  expect(
    evaluate(`
const __exposeOptions = { name: "meter", get publish() { throw Error("publish read"); } };
const __exposeName = "untouched";
const target: import("@unworklet/core").State<"f32"> = { expose(o) { return [o.name, __exposeName]; } };
const level = target.expose(__exposeOptions);
return level;
`),
  ).toEqual(["meter", "untouched"]);
});

for (const options of ["null", "undefined"]) {
  test(`whole ${options} options retain direct-core failure`, () => {
    expect(() =>
      lowerToProcessor(
        processor(`const exposure = ${options}; const level = state.f32(0).expose(exposure);`),
      ),
    ).toThrow(TypeError);
  });
}

for (const [declaration, options, error] of [
  [
    "state.f32(0)",
    "{ publish: { rateFps: 0 } }",
    "publish rateFps must be a positive finite number",
  ],
  ["state.buffer.f32({ size: 4 })", "{ publish: { rateFps: 30 } }", "buffer-publish-unsupported"],
] as const) {
  test(`restores core validation: ${error}`, () => {
    expect(() =>
      lowerToProcessor(
        processor(`const exposure = ${options}; const level = ${declaration}.expose(exposure);`),
      ),
    ).toThrow(error);
  });
}

test("fallback is applied together with publish without an intermediate name", () => {
  const result = lowerToProcessor(
    processor(`
const existing = state.f32(1).named("level");
const exposure = { name: "meter", publish: { rateFps: 30 } };
const level = state.f32(0).expose(exposure);`),
  );
  expect(result.worklet.publishSlots.map((slot) => slot.name)).toEqual(["meter"]);
});

test("generated adapter typechecks without capturing authored bindings", () => {
  const lowered = lower(
    processor(`
const __exposeOptions = { snapshot: "transient" as const, publish: { rateFps: 30 } };
const __exposeName = "meter";
const level = state.f32(0).expose(__exposeOptions);`),
  );
  const { program, sourceFile } = buildProgram(lowered);
  expect(
    program
      .getSemanticDiagnostics(sourceFile)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
  ).toEqual([]);
});

test("does not cache changing name getters or mutate frozen options", () => {
  expect(
    evaluate(`
let reads = 0;
const options = Object.freeze({ get name() { return "meter" + ++reads; } });
const target: import("@unworklet/core").State<"f32"> = { expose(o) { return [o.name, o.name]; } };
const level = target.expose(options);
return [level, reads];
`),
  ).toEqual([["meter1", "meter2"], 2]);
});

for (const [argument, expected] of [
  ["", "level"],
  ["{}", "level"],
  ['{ name: "meter" }', "meter"],
]) {
  test(`literal/omitted naming remains unchanged: ${argument}`, () => {
    expect(
      evaluate(
        `const target: import("@unworklet/core").State<"f32"> = { expose(o) { return o.name; } }; const level = target.expose(${argument}); return level;`,
      ),
    ).toBe(expected);
  });
}

test("adapter types use the configured core module", () => {
  const lowered = lower(
    processor(`const exposure = { name: "meter" }; const level = state.f32(0).expose(exposure);`),
    { coreModule: "custom-core" },
  );
  expect(lowered).toContain('import("custom-core").ExposeOptions');
  expect(lowered).not.toContain('"@unworklet/core"');
});

for (const argument of ["exposure", "getOptions()", '{ tag: "keep" }', ""]) {
  test(`custom expose receives unchanged options: ${argument || "omitted"}`, () => {
    expect(
      evaluate(`
const exposure = { name: "custom", tag: "keep" };
let calls = 0;
const getOptions = () => { calls++; return exposure; };
const widget = { expose(value) { return [value, value === exposure]; } };
const result = widget.expose(${argument});
return [result, calls];
`),
    ).toEqual([
      argument === ""
        ? [undefined, false]
        : argument.startsWith("{")
          ? [{ tag: "keep" }, false]
          : [{ name: "custom", tag: "keep" }, true],
      argument === "getOptions()" ? 1 : 0,
    ]);
  });
}

test("same-named custom types and mixed receivers are not core exposure", () => {
  const source = `
type State<T> = { expose(options: { name?: string; tag?: string }): string };
declare const fake: State<"f32">;
declare const mixed: import("@unworklet/core").State<"f32"> | State<"f32">;
const exposure = { name: "custom", tag: "keep" };
const result = fake.expose(exposure);
const uncertain = mixed.expose(exposure);
export { result, uncertain };
`;
  const lowered = lower(source);
  expect(lowered).toContain("fake.expose(exposure)");
  expect(lowered).toContain("mixed.expose(exposure)");
  expect(lowered).not.toContain("__exposeOptions");
});

test("imported custom expose keeps identity, custom fields, and generated types", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const path = await import("node:path");
  const { loadUwkProcessor } = await import("../index.ts");
  const dir = mkdtempSync(path.join(import.meta.dirname, "../../.expose-custom-"));
  try {
    writeFileSync(
      path.join(dir, "custom.ts"),
      `
export const exposure = { name: "custom", tag: "keep" };
export const widget = { expose(value: typeof exposure) {
  if (value !== exposure || value.tag !== "keep") throw Error("options changed");
  return 1;
} };`,
    );
    const file = path.join(dir, "processor.uwk.ts");
    const source = processor(`import { widget as state, exposure } from "./custom.ts";
const result = state.expose(exposure);`);
    writeFileSync(file, source);
    const lowered = lower(source, { sourcePath: file });
    const { program, sourceFile } = buildProgram(lowered, { sourcePath: file });
    expect(
      program
        .getSemanticDiagnostics(sourceFile)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    ).toEqual([]);
    await loadUwkProcessor(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [kind, factory, create] of [
  ["state", "s", "f32(0)"],
  ["buffer", "s.buffer", "f32({ size: 4 })"],
  ["param", "p", 'f32({ default: 1, min: 0, max: 2, automationRate: "k-rate" })'],
] as const) {
  for (const chain of [false, true]) {
    test(`core ${kind} ${chain ? "factory" : "handle"} aliases keep inferred exposure names`, () => {
      const declarations = chain
        ? `const original = ${factory}; const level = original.expose(exposure); const value = level.${create};`
        : `const original = ${factory}.${create}; const level = original.expose(exposure);`;
      const result = lowerToProcessor(
        processor(`
import { state as s, param as p } from "@unworklet/core";
const exposure = { snapshot: "transient" as const };
${declarations}`),
      );
      expect(result.graph).toMatchObject({
        declarations: expect.arrayContaining([
          expect.objectContaining({ kind, name: "level", snapshot: "transient" }),
        ]),
      });
    });
  }
}

test("core-only unions and optional handles keep exposure adaptation", () => {
  const lowered = lower(`
declare const both: import("@unworklet/core").State<"f32"> | import("@unworklet/core").Param;
declare const maybe: import("@unworklet/core").State<"f32"> | undefined;
const exposure = { snapshot: "transient" as const };
const level = both.expose(exposure);
const optional = maybe?.expose(exposure);
export { level, optional };`);
  expect(lowered).toContain('__exposeName === void 0 ? "level"');
  expect(lowered).toContain('__exposeName === void 0 ? "optional"');
});

test("unknown and custom intersection receivers keep their options", () => {
  const lowered = lower(`
declare const unknownHelper: any;
declare const extended: import("@unworklet/core").State<"f32"> & { expose(value: { tag: string }): string };
const exposure = { tag: "keep" };
const first = unknownHelper.expose(exposure);
const second = extended.expose(exposure);
export { first, second };`);
  expect(lowered).toContain("unknownHelper.expose(exposure)");
  expect(lowered).toContain("extended.expose(exposure)");
  expect(lowered).not.toContain("__exposeOptions");
});

test("captured browser snapshots preserve variable core exposure options", async () => {
  const { captureFsSnapshot } = await import("../capture.ts");
  const source = processor(
    `const exposure = { publish: { rateFps: 30 }, snapshot: "transient" as const }; const level = state.f32(0).expose(exposure);`,
  );
  const expected = lowerToProcessor(source);
  const actual = lowerToProcessor(source, captureFsSnapshot());
  expect(actual.graph).toEqual(expected.graph);
  expect(actual.worklet.publishSlots).toEqual(expected.worklet.publishSlots);
});

test("handles returned by imported helpers retain core exposure naming", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const path = await import("node:path");
  const { loadUwkProcessor } = await import("../index.ts");
  const dir = mkdtempSync(path.join(import.meta.dirname, "../../.expose-core-"));
  try {
    writeFileSync(
      path.join(dir, "handle.ts"),
      'import { state } from "@unworklet/core"; export function getHandle() { return state.f32(0); }',
    );
    const file = path.join(dir, "processor.uwk.ts");
    writeFileSync(
      file,
      processor(`import { getHandle } from "./handle.ts";
const exposure = { snapshot: "transient" as const, publish: { rateFps: 30 } };
const level = getHandle().expose(exposure);`),
    );
    const result = await loadUwkProcessor(file);
    expect(result.worklet.publishSlots.map((slot) => slot.name)).toEqual(["level"]);
    expect(result.graph).toMatchObject({
      declarations: expect.arrayContaining([
        expect.objectContaining({
          kind: "state",
          name: "level",
          snapshot: "transient",
          publish: { rateFps: 30 },
        }),
      ]),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
