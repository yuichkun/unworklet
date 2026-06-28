import { expect, test } from "vite-plus/test";

import { lower, LowerError } from "./lower.ts";

/** Names in the generated `import { ... } from "@unworklet/core"`. */
function importedNames(lowered: string): string[] {
  const m = lowered.match(/import \{([^}]*)\} from "@unworklet\/core"/);
  if (m === null) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STEREO_GAIN = `
const input = audioInput({ channels: 2, name: "main" });
const out = audioOutput({ channels: 2, name: "main" });
const gain = param.f32({ default: 1, min: 0, max: 4 }).named("gain");
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(input.ch(0).at(i).mul(gain.at(i)));
  });
});
`;

test("wraps process() + declarations into defineProcessor", () => {
  const out = lower(STEREO_GAIN);
  expect(out).toContain('from "@unworklet/core"');
  expect(out).toContain("export default defineProcessor");
  // The declarations survive inside the body.
  expect(out).toContain("audioInput({ channels: 2");
  expect(out).toContain('.named("gain")');
  // The process body is wrapped under a `process` thunk.
  expect(out).toContain("process:");
  expect(out).toContain("forSample");
  // The top-level `process(...)` macro is gone (no standalone call statement).
  expect(out).not.toMatch(/^process\(/m);
});

test("imports only the core authoring symbols actually used", () => {
  const names = importedNames(lower(STEREO_GAIN));
  expect(names).toContain("defineProcessor");
  expect(names).toContain("audioInput");
  expect(names).toContain("audioOutput");
  expect(names).toContain("param");
  expect(names).toContain("forSample");
  // `event` / `state` / math primitives are never referenced here.
  expect(names).not.toContain("event");
  expect(names).not.toContain("state");
  expect(names).not.toContain("mul"); // `.mul` is a method, not a free identifier
});

test("wires migrations() and options() into the defineProcessor options arg", () => {
  const out = lower(`
const g = param.f32({ default: 1, min: 0, max: 4 }).named("g");
process(() => {});
migrations([{ from: "a", to: "b" }]);
options({ migrationsStrict: true });
`);
  expect(out).toContain("migrations:");
  expect(out).toContain("migrationsStrict");
  // Both fold into the second argument object of defineProcessor.
  expect(out).toMatch(/defineProcessor\([\s\S]*\{[\s\S]*migrations:/);
});

test("supports an expression-bodied process callback", () => {
  const out = lower(`
const s = state.f32(0).named("s");
process(() => s.write(s.read().add(1)));
`);
  expect(out).toContain("export default defineProcessor");
  expect(out).toContain("process:");
  expect(importedNames(out)).toContain("state");
});

test("does not import a core name that appears only as a property", () => {
  const out = lower(`
const cfg = { min: 1, max: 2 };
const s = state.f32(cfg.min).named("s");
process(() => {});
`);
  const names = importedNames(out);
  // `min` / `max` only appear as `cfg.min` / object keys — not imported.
  expect(names).not.toContain("min");
  expect(names).not.toContain("max");
  expect(names).toContain("state");
});

test("rejects a file with no process() and no export (it would do nothing)", () => {
  // A .uwk.ts with neither a process() nor any export produces no processor and
  // exposes nothing — a mistake. (A no-process file WITH an export is a valid
  // library module; see the subgraph-only test below.)
  expect(() => lower(`const s = state.f32(0).named("s");`)).toThrow(LowerError);
  try {
    lower(`const s = state.f32(0).named("s");`);
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-empty");
  }
});

test("lowers a subgraph-only file to a plain library module (no defineProcessor wrap, no ambient I/O)", () => {
  // A .uwk.ts with no process() but with exports is a "library module": the
  // exports are emitted verbatim at module scope, the sugar in subgraph method
  // bodies is still desugared, and there is NO defineProcessor wrap and NO
  // synthesized ambient stereo I/O.
  const out = lower(
    `export const onepole = defineSubgraph((coef: Node<"f32">) => ({\n` +
      `  tick: (x: Node<"f32">) => x * coef,\n` +
      `}));`,
  );
  // The export survives verbatim at module scope.
  expect(out).toContain("export const onepole = defineSubgraph(");
  // Sugar in the method body is desugared (x * coef -> mul(x, coef)).
  expect(out).toContain("mul(");
  // No processor wrap, no synthesized ambient stereo I/O.
  expect(out).not.toContain("defineProcessor");
  expect(out).not.toContain("audioInput({ channels: 2");
  expect(out).not.toContain("audioOutput({ channels: 2");
  // The core import carries defineSubgraph + mul but NOT defineProcessor / audioInput.
  const names = importedNames(out);
  expect(names).toContain("defineSubgraph");
  expect(names).toContain("mul");
  expect(names).not.toContain("defineProcessor");
  expect(names).not.toContain("audioInput");
});

test("a library module keeps a sibling import at module scope", () => {
  const out = lower(
    `import { TWO_PI } from "./constants.ts";\n` +
      `export const osc = defineSubgraph((hz: Node<"f32">) => ({\n` +
      `  tick: () => hz * TWO_PI,\n` +
      `}));`,
  );
  expect(out).toContain('import { TWO_PI } from "./constants.ts"');
  // The sibling import sits at module scope, ahead of the exported subgraph.
  expect(out.indexOf("import { TWO_PI }")).toBeLessThan(out.indexOf("defineSubgraph"));
  // The injected core import drops nothing the user imports; TWO_PI is not core.
  expect(out).toContain("mul("); // hz * TWO_PI desugared
});

test("rejects more than one process() call", () => {
  try {
    lower(`process(() => {});\nprocess(() => {});`);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-multiple-process");
  }
});

test("rejects a process() without an arrow / function callback", () => {
  try {
    lower(`process(123);`);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-bad-process");
  }
});

test("preserves a user import at module top-level (cross-file constant sharing)", () => {
  // Imports must survive at module scope — not be moved into the defineProcessor
  // callback (an illegal nested import) — so a `.uwk.ts` can share constants /
  // params from sibling files. The lowered module is written next to the source,
  // so the relative specifier resolves unchanged.
  const out = lower(
    `import { BASE_GAIN } from "./constants.ts";\n` +
      `const out = audioOutput({ channels: 1, name: "main" });\n` +
      `process(() => {\n` +
      `  forSample((i) => {\n` +
      `    out.ch(0).at(i).write(f32(BASE_GAIN));\n` +
      `  });\n` +
      `});`,
  );
  expect(out).toContain('import { BASE_GAIN } from "./constants.ts"');
  // It sits at module scope, ahead of the defineProcessor wrap — not nested inside.
  const userImportIdx = out.indexOf("import { BASE_GAIN }");
  expect(userImportIdx).toBeGreaterThanOrEqual(0);
  expect(userImportIdx).toBeLessThan(out.indexOf("defineProcessor"));
  // The injected core import is still emitted and the constant is referenced.
  expect(out).toContain('from "@unworklet/core"');
  expect(out).toContain("f32(BASE_GAIN)");
});

test("a user import of an ambient core name keeps a single binding (no duplicate)", () => {
  // Importing a name the DSL already provides ambiently must not double-bind it:
  // the injected core import drops any name the user imports explicitly.
  const out = lower(
    `import { state } from "@unworklet/core";\n` +
      `const s = state.f32(0).named("s");\n` +
      `process(() => {\n` +
      `  s.write(f32(1));\n` +
      `});`,
  );
  expect(out).toContain('import { state } from "@unworklet/core"');
  // The injected import (the one carrying defineProcessor) must NOT also bind `state`.
  const coreImports = out.match(/import \{[^}]*\} from "@unworklet\/core"/g) ?? [];
  const injected = coreImports.find((i) => i.includes("defineProcessor"))!;
  expect(injected).not.toContain("state");
});

test("rejects migrations()/options() referencing a processor-body binding", () => {
  // `migrate` is moved into the defineProcessor callback, so referencing it from
  // migrations() — which is attached outside the callback — is out of scope
  // (reported by @codex on #12).
  try {
    lower(`const migrate = (h) => h;\nmigrations([{ to: 1, migrate }]);\nprocess(() => {});`);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-options-binding");
  }
});

test("rejects migrations() referencing a moved FUNCTION declaration", () => {
  // A function declaration is moved into the callback just like a const binding,
  // so referencing it from migrations() is equally out of scope. (Reported by
  // @codex on #12 — the first guard only collected identifier `const`s.)
  try {
    lower(
      `function migrate(blob, h) { return h; }\nmigrations([{ to: 1, migrate }]);\nprocess(() => {});`,
    );
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-options-binding");
  }
});

test("rejects migrations() referencing a DESTRUCTURED top-level binding", () => {
  try {
    lower(`const { migrate } = helpers;\nmigrations([{ to: 1, migrate }]);\nprocess(() => {});`);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-options-binding");
  }
});

test("rejects options() referencing a moved CLASS declaration", () => {
  // A class declaration is moved into the callback like a const / function binding,
  // so referencing it from the (outside-the-callback) options arg is out of scope.
  try {
    lower(`class Tag {}\noptions({ tag: Tag });\nprocess(() => {});`);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-options-binding");
  }
});

test("rejects migrations() referencing an ARRAY-DESTRUCTURED binding (with a hole)", () => {
  // Array destructuring with a hole (`[, second]`) exercises the omitted-element
  // path of the binding-name scan; the named element is still collected, so a
  // migrations() reference to it is caught as out of scope.
  try {
    lower(
      `const [, second] = pair;\nmigrations([{ to: 1, migrate: second }]);\nprocess(() => {});`,
    );
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-options-binding");
  }
});

test("a top-level class declaration is moved into the processor body untouched", () => {
  // A class that is NOT referenced from options()/migrations() is a valid body
  // declaration and survives verbatim inside the defineProcessor callback.
  const lowered = lower(`class Helper {}\nprocess(() => {});`);
  expect(lowered).toContain("class Helper");
});

test("rejects a process() with no callback argument", () => {
  try {
    lower(`process();`);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as LowerError).id).toBe("uwk-bad-process");
  }
});

test("preserves top-level non-macro statements (member call, bare expression)", () => {
  const out = lower(`
const obj = { run: () => {} };
obj.run();
0;
const s = state.f32(0).named("s");
process(() => {});
`);
  // A member-call (non-identifier callee) and a bare expression are not macros,
  // so they pass through into the declaration scope unchanged.
  expect(out).toContain("obj.run()");
  expect(importedNames(out)).toContain("state");
});

test("does not import a core name used as a destructuring property", () => {
  const out = lower(`
const obj = { min: 1, clamp: 2 };
const { min: lo } = obj;
const s = state.f32(lo).named("s");
process(() => {});
`);
  const names = importedNames(out);
  expect(names).not.toContain("min"); // binding property name
  expect(names).not.toContain("clamp"); // object literal key
  expect(names).toContain("state");
});

test("S12: injects ambient stereo input / out when neither is declared (Tier C)", () => {
  const out = lower(`
const gain = param.f32({ default: 1, min: 0, max: 4 }).named("gain");
process(() => {
  forSample((i) => {
    out.left.at(i).write(input.left.at(i).mul(gain.at(i)));
  });
});
`);
  expect(out).toContain('audioInput({ channels: 2, name: "input" })');
  expect(out).toContain('audioOutput({ channels: 2, name: "out" })');
  const names = importedNames(out);
  expect(names).toContain("audioInput");
  expect(names).toContain("audioOutput");
});

test("S12: an explicit audioInput / audioOutput suppresses the ambient injection", () => {
  const out = lower(`
const input = audioInput({ channels: 1, name: "main" });
const sink = audioOutput({ channels: 1, name: "main" });
process(() => {});
`);
  // The explicit mono declarations win; no stereo ambient pair is added.
  expect(out).not.toContain('name: "input"');
  expect(out).not.toContain('name: "out"');
  expect(out).toContain("channels: 1");
});

/** Everything from the `defineProcessor(` call onward — the part that compiles. */
function processorBody(lowered: string): string {
  return lowered.slice(lowered.indexOf("defineProcessor("));
}

test("exportName emits a named export instead of the default export", () => {
  const named = lower(STEREO_GAIN, { exportName: "stereoGain" });
  expect(named).toContain("export const stereoGain = defineProcessor(");
  expect(named).not.toContain("export default");
});

test("exportName changes only the export statement, not the processor body", () => {
  // The defineProcessor call must be byte-identical with or without exportName, so
  // a named-exported .uwk.ts compiles to the same CompiledProcessor as the default.
  const def = lower(STEREO_GAIN);
  const named = lower(STEREO_GAIN, { exportName: "stereoGain" });
  expect(processorBody(named)).toBe(processorBody(def));
});

test("omitting exportName keeps the default export (lang golden compatibility)", () => {
  const out = lower(STEREO_GAIN);
  expect(out).toContain("export default defineProcessor(");
  expect(out).not.toMatch(/export const \w+ = defineProcessor/);
});
