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

// ── module-scope exports in a processor file (issue #44) ─────────────────────
// Lowering wraps the file body into defineProcessor((ctx) => {...}); an
// `export` swallowed into the callback is a SyntaxError in the emitted module.
// Exported declarations whose dependency closure never touches the DSL are
// hoisted (closure included) to module scope; DSL-dependent exports are a
// loud LowerError instead of invalid emit.

const EXPORT_REPRO = `
export const GAIN = 0.5;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(GAIN);
  });
});
`;

test("a module-scope export hoists out of the defineProcessor wrapper (issue #44 repro)", () => {
  const lowered = lower(EXPORT_REPRO);
  expect(lowered).toContain("export const GAIN = 0.5;");
  expect(lowered.indexOf("export const GAIN")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a hoisted export pulls its non-exported dependencies along (closure hoist)", () => {
  const lowered = lower(`
const SCALE = 2;
export const GAIN = 0.25 * SCALE;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(GAIN);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("const SCALE = 2;")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export const GAIN")).toBeLessThan(defineAt);
});

test("an untainted local NOT referenced by any hoisted export stays inside the wrapper", () => {
  const lowered = lower(`
export const GAIN = 0.5;
const bias = 0.1;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(GAIN + bias);
  });
});
`);
  expect(lowered.indexOf("const bias = 0.1;")).toBeGreaterThan(lowered.indexOf("defineProcessor("));
});

test("an exported helper function hoists to module scope", () => {
  const lowered = lower(`
export function midiToHz(n: number): number {
  return 440 * 2 ** ((n - 69) / 12);
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(midiToHz(69) / 1000);
  });
});
`);
  expect(lowered.indexOf("export function midiToHz")).toBeLessThan(
    lowered.indexOf("defineProcessor("),
  );
});

test("a pure helper whose parameters shadow DSL names hoists (taint resolves through scopes)", () => {
  // `min` / `max` / `input` are DSL roots, and they are also ordinary parameter
  // names. A spelling-only scan marks this helper DSL-tainted and rejects it —
  // the reference has to resolve to its binding, which here is the parameter.
  const lowered = lower(`
export function clampTo(input: number, min: number, max: number): number {
  return input < min ? min : input > max ? max : input;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(clampTo(0.25, 0, 1));
  });
});
`);
  expect(lowered.indexOf("export function clampTo")).toBeLessThan(
    lowered.indexOf("defineProcessor("),
  );
});

test("an exported binding whose own name is a DSL root hoists without double-binding it", () => {
  // The file's `clamp` owns that name for the whole module, so its declaration
  // is not a reference to the ambient DSL `clamp` — and the injected core
  // import must not bind the name a second time (a duplicate top-level binding
  // is a SyntaxError in the emitted module).
  const lowered = lower(`
export const clamp = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(clamp(0.25));
  });
});
`);
  expect(lowered.indexOf("export const clamp")).toBeLessThan(lowered.indexOf("defineProcessor("));
  expect(importedNames(lowered)).not.toContain("clamp");
});

test("an export built from a helper imported under a DSL name hoists", () => {
  // The import is explicit: `clamp` here is the sibling module's, not the
  // ambient DSL one, so the export is not DSL-tied.
  const lowered = lower(`
import { clamp } from "./math.ts";
export const normalized = clamp(0.5);
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(normalized);
  });
});
`);
  expect(lowered.indexOf("export const normalized")).toBeLessThan(
    lowered.indexOf("defineProcessor("),
  );
  expect(importedNames(lowered)).not.toContain("clamp");
});

test("an export built from a helper imported FROM the core keeps DSL semantics", () => {
  // `clamp` imported from @unworklet/core is the DSL one — a value built with
  // it belongs to the capture, so hoisting it to module scope is still refused.
  try {
    lower(`
import { clamp } from "@unworklet/core";
export const limited = clamp(state.f32(0).read(), 0, 1);
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(limited);
  });
});
`);
    expect.unreachable("lower() must reject an export tied to the core DSL");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an export built through an ALIASED core import is still refused", () => {
  // The alias is spelled nothing like a DSL root, but it is one — hoisting the
  // export would call the DSL at module scope, outside any capture.
  try {
    lower(`
import { state as makeState } from "@unworklet/core";
export const level = makeState.f32(0).read();
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(level);
  });
});
`);
    expect.unreachable("lower() must reject an export built through an aliased core import");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an export built through a core NAMESPACE import is still refused", () => {
  try {
    lower(`
import * as core from "@unworklet/core";
export const level = core.state.f32(0).read();
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(level);
  });
});
`);
    expect.unreachable("lower() must reject an export built through a core namespace import");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a hoisted export pulls a module-level enum along with it", () => {
  // An enum is a runtime value, so an export reading a member depends on it the
  // same way it would on a const — leaving it in the wrapper puts the export's
  // initializer out of scope at module evaluation.
  const lowered = lower(`
enum Mode { Soft, Hard }
export const DEFAULT_MODE = Mode.Soft;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(DEFAULT_MODE);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("enum Mode")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export const DEFAULT_MODE")).toBeLessThan(defineAt);
});

test("a core name reached only through a type is erased, so the export hoists", () => {
  // `Node` here is a type import used in type positions: it disappears at
  // emit and carries no dependency on the capture.
  const lowered = lower(`
import type { Node } from "@unworklet/core";
export type Signal = Node<"f32">;
export function describe(_x: Node<"f32">): string {
  return "signal";
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("export type Signal")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export function describe")).toBeLessThan(defineAt);
});

test("a hoisted export carries the type alias its annotation names", () => {
  // The alias is erased at emit, but the annotation still has to resolve where
  // the declaration lands — leaving it in the callback puts it out of scope.
  const lowered = lower(`
type Gain = number;
export const DEFAULT: Gain = 0.5;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(DEFAULT);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("type Gain = number;")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export const DEFAULT")).toBeLessThan(defineAt);
});

test("a type and a value sharing a name keep separate dependency edges", () => {
  // TS puts them in different namespaces, so the export's `Level.read()` is the
  // DSL-tied const — the interface must not stand in for it and let the export
  // hoist away from the value its initializer needs.
  try {
    lower(`
const Level = state.f32(0);
interface Level { db: number }
export const RESULT = Level.read();
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(RESULT);
  });
});
`);
    expect.unreachable("lower() must reject an export reaching the DSL-tied value");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a type and a value sharing a name both travel with a pure export", () => {
  const lowered = lower(`
interface Level { db: number }
const Level: Level = { db: 6 };
export const CURRENT: Level = Level;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(CURRENT.db);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("interface Level")).toBeLessThan(defineAt);
  expect(lowered.indexOf("const Level: Level")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export const CURRENT")).toBeLessThan(defineAt);
});

test("`typeof X` reads the value namespace even when a type shares the name", () => {
  // `typeof Level` names the const, so hoisting the alias would need that
  // DSL-tied value at module scope — the interface must not answer for it.
  try {
    lower(`
const Level = state.f32(0);
interface Level { db: number }
export type Snapshot = typeof Level;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject a type query reaching a DSL-tied value");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("`export { type X }` selects the type declaration, not the value sharing its name", () => {
  const lowered = lower(`
const Level = state.f32(0);
interface Level { db: number }
export { type Level };
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(Level.read());
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("interface Level")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export { type Level }")).toBeLessThan(defineAt);
  // The DSL-tied const belongs to the capture and stays in the wrapper.
  expect(lowered.indexOf("const Level = state.f32(0)")).toBeGreaterThan(defineAt);
});

test("`export type { X }` selects the type declaration too", () => {
  const lowered = lower(`
const Level = state.f32(0);
interface Level { db: number }
export type { Level };
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(Level.read());
  });
});
`);
  expect(lowered.indexOf("interface Level")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("every declaration of a merged binding travels with a hoisted export", () => {
  // Namespaces (and interfaces, and function overloads) merge across
  // statements. Carrying only the last one out leaves the hoisted name missing
  // half of itself.
  const lowered = lower(`
namespace Tuning { export const A4 = 440; }
namespace Tuning { export const REF = 69; }
export const BASE = Tuning.A4 / Tuning.REF;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(BASE);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("A4 = 440")).toBeLessThan(defineAt);
  expect(lowered.indexOf("REF = 69")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export const BASE")).toBeLessThan(defineAt);
});

test("a destructuring property key is a name, not a reference to the DSL", () => {
  // `input` here is the key being read from, not a value the helper depends on
  // — the only binding it introduces is `value`.
  const lowered = lower(`
export function read({ input: value }: { input: number }): number {
  return value;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(read({ input: 0.25 }));
  });
});
`);
  expect(lowered.indexOf("export function read")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("`export { X }` refuses when the type sharing the name is DSL-tied", () => {
  // `typeof input` names a VALUE that lives inside the capture, so the alias
  // cannot sit at module scope — and a plain `export { Level }` carries both
  // declarations of the name, so checking only the pure const is not enough.
  try {
    lower(`
const Level = 1;
type Level = typeof input;
export { Level };
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(Level);
  });
});
`);
    expect.unreachable("lower() must reject an export whose type side reaches the DSL");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an interface member key is a name, not a reference to the const sharing it", () => {
  const lowered = lower(`
const gain = state.f32(0);
export interface Levels { gain: number; read(): number }
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(gain.read());
  });
});
`);
  expect(lowered.indexOf("export interface Levels")).toBeLessThan(
    lowered.indexOf("defineProcessor("),
  );
});

test("declaring a name the lowering itself generates is a loud error", () => {
  // The wrapper the lowering emits calls `defineProcessor`. A file that binds
  // that name would have its own helper called instead, and the module would
  // export something that is not a processor.
  try {
    lower(`
export const defineProcessor = (x: unknown): unknown => x;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject a declaration colliding with generated code");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-reserved-binding");
    expect((e as LowerError).message).toContain("defineProcessor");
  }
});

test("declaring the ambient I/O name the lowering would synthesize is a loud error", () => {
  // With no audio declaration of its own, the file gets `const out =
  // audioOutput(...)` injected — a file-level `out` would be the name that
  // declaration binds.
  try {
    lower(`
export const out = 0.5;
process(() => {
  forSample((i) => {
    void i;
  });
});
`);
    expect.unreachable("lower() must reject a declaration colliding with the ambient I/O");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-reserved-binding");
  }
});

test("the canonical `const out = audioOutput(...)` is untouched by that rule", () => {
  // The name is only reserved when the lowering is about to generate it, and
  // a file that declares its own output suppresses the injection.
  const lowered = lower(`
const out = audioOutput({ channels: 1, name: "main" });
export const GAIN = 0.5;
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(GAIN);
  });
});
`);
  expect(lowered.indexOf("export const GAIN")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a function-scoped `var` shadows a DSL name across the whole helper", () => {
  // `var` is scoped to the function, not the block it sits in, so the later
  // reference is the helper's own binding.
  const lowered = lower(`
export function pick(): number {
  {
    var input = 2;
  }
  return input;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(pick() / 10);
  });
});
`);
  expect(lowered.indexOf("export function pick")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a wrapper-local declaration sharing a DSL name is not imported either", () => {
  const lowered = lower(`
const min = 0.25;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min);
  });
});
`);
  expect(importedNames(lowered)).not.toContain("min");
  expect(lowered.indexOf("const min = 0.25;")).toBeGreaterThan(lowered.indexOf("defineProcessor("));
});

test("a local binding shadowing a DSL name does not untaint an unshadowed DSL reference", () => {
  // The arrow's own `state` parameter is local, but the initializer also names
  // the real DSL `state` — scope resolution must keep that one tainted.
  try {
    lower(`
export const level = ((state: number) => state * 2)(0.5) + state.f32(0).read();
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(level);
  });
});
`);
    expect.unreachable("lower() must reject an export reaching the real DSL `state`");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a local export list (`export { X }`) hoists together with its bindings", () => {
  const lowered = lower(`
const GAIN = 0.5;
export { GAIN };
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(GAIN);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("const GAIN = 0.5;")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export { GAIN };")).toBeLessThan(defineAt);
});

test("a DSL-dependent export is a loud LowerError, never invalid emit", () => {
  try {
    lower(`
export const gain = param.f32({ default: 1, min: 0, max: 4 });
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(gain.at(i));
  });
});
`);
    expect.unreachable("lower() must reject a DSL-dependent export");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("gain");
  }
});

test("`export default` in a processor file is a loud LowerError (the processor owns that slot)", () => {
  try {
    lower(`
export default 42;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0);
  });
});
`);
    expect.unreachable("lower() must reject export default in a processor file");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an exported destructuring declaration is a loud LowerError (unsupported form)", () => {
  try {
    lower(`
const pair = { a: 1, b: 2 };
export const { a } = pair;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0);
  });
});
`);
    expect.unreachable("lower() must reject an exported destructuring declaration");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});
