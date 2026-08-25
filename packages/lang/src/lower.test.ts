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

test("a re-export names the other module's binding, never a local one", () => {
  // `export { gain } from "./constants.ts"` says nothing about the `gain` this
  // file declares — dragging that DSL-tied const out with it would run a
  // capture-only call at module scope.
  const lowered = lower(`
const gain = state.f32(0);
export { gain } from "./constants.ts";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(gain.read());
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf('export { gain } from "./constants.ts"')).toBeLessThan(defineAt);
  expect(lowered.indexOf("const gain = state.f32(0)")).toBeGreaterThan(defineAt);
});

test("a statement label is a name in its own namespace, not a DSL reference", () => {
  const lowered = lower(`
export function scan(n: number): number {
  let total = 0;
  input: for (let i = 0; i < n; i++) {
    if (i > 2) break input;
    total += i;
  }
  return total;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(scan(4) / 10);
  });
});
`);
  expect(lowered.indexOf("export function scan")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("an enum member is in scope for a later member's initializer", () => {
  const lowered = lower(`
export enum Mode {
  input = 1,
  Copy = input,
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(Mode.Copy / 10);
  });
});
`);
  expect(lowered.indexOf("enum Mode")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("importing a generated name from another module is the same collision", () => {
  // The injected core import drops any name the file binds itself, an import
  // included — so this would leave the wrapper calling the sibling's helper.
  try {
    lower(`
import { defineProcessor } from "./helper.ts";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject an import that shadows generated code");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-reserved-binding");
  }
});

test("importing a generated name FROM the core is the same binding, so it is fine", () => {
  const lowered = lower(`
import { defineProcessor } from "@unworklet/core";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
  expect(lowered).toContain("defineProcessor(");
});

test("a body `var` does not shadow what a parameter initializer reads", () => {
  // JavaScript evaluates a default in the parameter scope, where the body's
  // `var input` does not exist yet — so `value = input` reads the ambient DSL
  // input, and the helper cannot leave the capture.
  try {
    lower(`
export function read(value = input): unknown {
  var input = 1;
  return value ?? input;
}
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject a helper whose default reads the ambient input");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a module-scoped `var` nested in a statement travels with the export that reads it", () => {
  // `var` belongs to the module, not the `if` it sits in, so the export
  // depends on that whole statement.
  const lowered = lower(`
if (true) {
  var helper = 1;
}
export const value = helper;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("var helper = 1")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export const value")).toBeLessThan(defineAt);
});

test("a type-only import of a generated name is refused (it binds no value)", () => {
  // TypeScript erases it, so it cannot supply the wrapper's `defineProcessor`,
  // and keeping the injected value import beside it would double-bind the name.
  try {
    lower(`
import type { defineProcessor } from "@unworklet/core";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject a type-only import of a generated name");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-reserved-binding");
  }
});

test("an aliased core import is not the generated binding it shadows", () => {
  // The local name is `audioInput`, but it is bound to `defineProcessor` — the
  // ambient declaration would call the wrong factory.
  try {
    lower(`
import { defineProcessor as audioInput } from "@unworklet/core";
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject an alias that shadows a generated name");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-reserved-binding");
  }
});

test("a nested module-scoped `var` collides with a generated name too", () => {
  // The `if` moves into the callback, where its function-scoped `var` shadows
  // the injected import for the synthesized call.
  try {
    lower(`
if (false) {
  var audioInput = 1;
}
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject a nested var that shadows a generated name");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-reserved-binding");
  }
});

test("a class static block is its own `var` scope, not the helper's", () => {
  try {
    lower(`
export function pick(): unknown {
  class C {
    static {
      var input = 1;
      void input;
    }
  }
  void C;
  return input;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject a helper reading the ambient input");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a type parameter shadows a module value of the same name", () => {
  // `min` is both a DSL root and this file's own DSL-tied const, so a type
  // parameter spelled the same would otherwise inherit that dependency.
  const lowered = lower(`
const min = state.f32(0);
export function id<min>(value: min): min {
  return value;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
  expect(lowered.indexOf("export function id")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a type parameter does not hide a VALUE of the same name", () => {
  // The complement of the test above: `min` here is read as an expression, and
  // a type parameter names no value, so this reaches the DSL-tied const.
  try {
    lower(`
const min = state.f32(0);
export function read<min>(): number {
  return min.read();
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
    expect.unreachable("lower() must see the value reference under a type parameter");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a parameter does not hide a TYPE of the same name", () => {
  // The annotation `: Level` reads the module's type alias, not the parameter,
  // so the alias has to travel to module scope with the export that names it.
  const lowered = lower(`
type Level = number;
export function read(Level: number): Level {
  return Level;
}
const min = state.f32(0);
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
  const wrapper = lowered.indexOf("defineProcessor(");
  const alias = lowered.indexOf("type Level");
  expect(lowered.indexOf("export function read")).toBeLessThan(wrapper);
  expect(alias).toBeGreaterThanOrEqual(0);
  expect(alias).toBeLessThan(wrapper);
});

test("a class static block scopes its own nested `var`", () => {
  const lowered = lower(`
export function pick(ok: boolean): number {
  class C {
    static {
      if (ok) {
        var input = 1;
      }
      void input;
    }
  }
  void C;
  return 2;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(pick(true) / 10);
  });
});
`);
  expect(lowered.indexOf("export function pick")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a `var` inside a namespace is that namespace's, not the module's", () => {
  // Recording it as an outer binding would make the export look like it
  // depends on the pure namespace instead of the DSL, and hoist it.
  try {
    lower(`
namespace N {
  var state = 1;
  void state;
}
export const gain = state.f32(0);
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(gain.read());
  });
});
`);
    expect.unreachable("lower() must reject an export tied to the DSL `state`");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a mapped type's parameter shadows a module value of the same name", () => {
  const lowered = lower(`
const min = state.f32(0);
export type Keys = { [min in "x"]: min };
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
  expect(lowered.indexOf("export type Keys")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a namespace sees the `var`s nested inside its own body", () => {
  const lowered = lower(`
export namespace Cfg {
  if (true) {
    var input = 1;
  }
  export const copy = input;
}
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(Cfg.copy / 10);
  });
});
`);
  expect(lowered.indexOf("namespace Cfg")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("an `infer` parameter shadows a module value inside the true branch", () => {
  const lowered = lower(`
const min = state.f32(0);
export type Element<T> = T extends infer min ? min : never;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
  expect(lowered.indexOf("export type Element")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("the right side of a qualified type name is a member, not a reference", () => {
  const lowered = lower(`
import type * as Types from "./types.ts";
const min = state.f32(0);
export type Signal = Types.min;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
  expect(lowered.indexOf("export type Signal")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a class `extends` expression is a value, not an erased heritage type", () => {
  // `extends makeBase(input)` runs at class evaluation, so it reads the ambient
  // input that lives inside the capture — the class cannot leave the wrapper.
  try {
    lower(`
const makeBase = (x: unknown): unknown => class {};
export class Helper extends (makeBase(input) as new () => object) {}
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(0.25);
  });
});
`);
    expect.unreachable("lower() must reject a class whose heritage reads the ambient input");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a named tuple label is a name, not a reference", () => {
  const lowered = lower(`
const min = state.f32(0);
export type Pair = [min: number, max: number];
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
  expect(lowered.indexOf("export type Pair")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("an import-type qualifier names a member of that module, not a local", () => {
  const lowered = lower(`
const min = state.f32(0);
export type Signal = import("./types.ts").min;
export type Deep = import("./types.ts").min.inner;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(min.read());
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("export type Signal")).toBeLessThan(defineAt);
  expect(lowered.indexOf("export type Deep")).toBeLessThan(defineAt);
});

test("a write standing before a hoisted export is refused, not silently skipped", () => {
  // The declaration and the export hoist; a bare `helper = 1` between them has
  // nothing referencing it, so it would stay in the wrapper and the exported
  // value would read 0 — a value the source never says.
  try {
    lower(`
let helper = 0;
helper = 1;
export const value = helper;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must reject an export whose dependency is mutated before it");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("helper");
  }
});

test("a write standing AFTER the export it cannot affect is left alone", () => {
  // Source order already gives the export the pre-write value, so hoisting it
  // past a later write changes nothing.
  const lowered = lower(`
let helper = 0;
export const value = helper;
helper = 1;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write((value + helper) / 10);
  });
});
`);
  const defineAt = lowered.indexOf("defineProcessor(");
  expect(lowered.indexOf("export const value")).toBeLessThan(defineAt);
  expect(lowered.indexOf("helper = 1;")).toBeGreaterThan(defineAt);
});

test("a helper that assigns without running is not mistaken for a write", () => {
  const lowered = lower(`
let helper = 0;
const bump = (): void => {
  helper = 1;
};
export const value = helper;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  bump();
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a write THROUGH a hoisted dependency blocks the same way a direct one does", () => {
  // `helper.value = 1` mutates the object the export reads, so leaving it in
  // the wrapper gives the export the pre-write contents.
  try {
    lower(`
const helper = { value: 0 };
helper.value = 1;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable(
      "lower() must reject an export whose dependency is mutated through a property",
    );
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("helper");
  }
});

test("an indexed write through a hoisted dependency blocks too", () => {
  try {
    lower(`
const table = [0, 0];
table[0] = 1;
export const first = table[0];
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(first / 10);
  });
});
`);
    expect.unreachable("lower() must reject an export whose dependency is mutated by index");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("table");
  }
});

test("a `delete` through a hoisted dependency blocks too", () => {
  try {
    lower(`
const helper: { value?: number } = { value: 1 };
delete helper.value;
export const value = helper.value ?? 0;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must reject an export whose dependency has a property deleted");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("helper");
  }
});

test("a for-of that assigns into an existing binding blocks too", () => {
  // The loop initializer is a target, not a declaration — it writes `slot`
  // every iteration.
  try {
    lower(`
let slot = 0;
for (slot of [1, 2]) {
  void slot;
}
export const value = slot;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must reject an export whose dependency a loop assigns");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("slot");
  }
});

test("a write through a plain alias reaches the binding it aliases", () => {
  try {
    lower(`
const helper = { value: 0 };
const alias = helper;
alias.value = 1;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must reject an export mutated through an alias");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an assertion or non-null wrapper does not hide the write's root", () => {
  try {
    lower(`
const helper: { value?: number } = { value: 0 };
(helper as { value: number }).value = 1;
export const value = helper.value ?? 0;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see through an `as` wrapper on a write target");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("helper");
  }
});

test("a non-null wrapper does not hide the write's root either", () => {
  try {
    lower(`
const helper: { value?: number } | null = { value: 0 };
helper!.value = 1;
export const value = helper?.value ?? 0;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see through a `!` wrapper on a write target");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a write to a shadowing local is not a write to the module binding", () => {
  // The block mutates its OWN `helper`; the export's dependency is untouched,
  // so the same spelling must not block it.
  const lowered = lower(`
const helper = { value: 0 };
{
  const helper = { value: 0 };
  helper.value = 1;
}
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a `var` in a block still writes the module binding it belongs to", () => {
  // `var` is not block-scoped, so this one really does write the outer name.
  try {
    lower(`
let helper = 0;
{
  var helper2 = 0;
  helper = 1;
  void helper2;
}
export const value = helper;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must still see a write that is not shadowed");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an export reading through an alias still sees a write to the source", () => {
  // The write names `helper`; the export names `alias`. They are the same
  // object, so the export's closure — not just its direct references — decides.
  try {
    lower(`
const helper = { value: 0 };
const alias = helper;
helper.value = 1;
export const value = alias.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable(
      "lower() must reject an export reading through an alias of a written source",
    );
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an object-rest assignment target is a write", () => {
  try {
    lower(`
let helper = { value: 0 };
const source = { value: 1 };
({ ...helper } = source);
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must reject an export whose dependency is a rest target");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a class static block scopes its own write target", () => {
  const lowered = lower(`
const helper = { value: 0 };
class C {
  static {
    let helper = { value: 0 };
    helper.value = 1;
  }
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a class static block's UNshadowed write is still seen", () => {
  try {
    lower(`
const helper = { value: 0 };
class C {
  static {
    helper.value = 1;
  }
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write inside a static block");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an instance field initializer is not a write where the class stands", () => {
  // It runs when an instance is constructed, so it does not precede the export
  // the way a statement does.
  const lowered = lower(`
const helper = { value: 0 };
class C {
  field = (helper.value = 1);
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a STATIC field initializer does write where the class stands", () => {
  try {
    lower(`
const helper = { value: 0 };
class C {
  static field = (helper.value = 1);
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a static field initializer's write");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a destructuring default target is a write", () => {
  try {
    lower(`
let helper = 0;
const source = { x: 2 };
({ x: helper = 1 } = source);
export const value = helper;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a destructuring default target as a write");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
    expect((e as LowerError).message).toContain("helper");
  }
});

test("a computed member name is evaluated where the class stands", () => {
  // The method body is deferred; its key is not.
  try {
    lower(`
const helper = { value: 0 };
class C {
  [helper.value = 1]() {}
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write in a computed method name");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a computed name on a deferred instance field is evaluated too", () => {
  try {
    lower(`
const helper = { value: 0 };
class C {
  [helper.value = 1] = 0;
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write in a computed field name");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a member decorator is evaluated where the class stands", () => {
  // The method body is deferred; the decorator applied to it is not.
  try {
    lower(`
const helper = { value: 0 };
class C {
  @((helper.value = 1), (() => {})) m() {}
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write in a method decorator");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a decorator on a deferred instance field is evaluated too", () => {
  try {
    lower(`
const helper = { value: 0 };
class C {
  @((helper.value = 1), (() => {})) f = 0;
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write in a field decorator");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a parameter decorator is evaluated with the class", () => {
  try {
    lower(`
const helper = { value: 0 };
class C {
  m(@((helper.value = 1), (() => {})) p: number) { void p; }
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write in a parameter decorator");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a parameter default stays with the call, not with the class", () => {
  const lowered = lower(`
const helper = { value: 0 };
class C {
  m(p = (helper.value = 1)) { void p; }
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a `var` inside a class static block belongs to that block", () => {
  const lowered = lower(`
const helper = { value: 0 };
class C {
  static {
    var helper = { value: 0 };
    helper.value = 1;
  }
}
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a named class expression binds its own name inside itself", () => {
  const lowered = lower(`
const helper = { value: 0 };
const C = class helper {
  static { helper.value = 1; }
};
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a class expression's decorator sees the class name, not the module's", () => {
  // The decorator list is built inside the scope that holds the class name, so
  // `helper` there is the class — never the module binding of the same name.
  const lowered = lower(`
const helper = { value: 0 };
const C = (@((helper.value = 1), (() => {})) class helper {});
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a class expression writing an OUTER name is still seen", () => {
  try {
    lower(`
const helper = { value: 0 };
const C = class Other {
  static { helper.value = 1; }
};
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write to a name the class does not bind");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an anonymous class expression binds nothing", () => {
  try {
    lower(`
const helper = { value: 0 };
const C = class {
  static { helper.value = 1; }
};
void C;
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write inside an anonymous class expression");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a namespace body is its own `var` scope for writes", () => {
  const lowered = lower(`
const helper = { value: 0 };
namespace N {
  var helper = { value: 0 };
  helper.value = 1;
}
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a namespace's NESTED `var` belongs to the namespace", () => {
  const lowered = lower(`
const helper = { value: 0 };
namespace N {
  {
    var helper = { value: 0 };
  }
  helper.value = 1;
}
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a block-scoped namespace or enum name shadows a write target", () => {
  const lowered = lower(`
const helper = { value: 0 };
{
  namespace helper {
    export const x = 1;
  }
  helper.value = 1;
}
{
  enum helper {
    A,
  }
  helper.value = 1;
}
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a namespace's UNshadowed write is still seen", () => {
  try {
    lower(`
const helper = { value: 0 };
namespace N {
  helper.value = 1;
}
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
    expect.unreachable("lower() must see a write a namespace does not shadow");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an import alias binds its name against a write", () => {
  const lowered = lower(`
const helper = { value: 0 };
namespace Source {
  export const helper = { value: 0 };
}
namespace N {
  import helper = Source.helper;
  helper.value = 1;
}
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("an import alias binds its name against a DSL root", () => {
  // `state` here is the alias, so nothing in this file reaches the DSL.
  const lowered = lower(`
namespace Source {
  export const value = 3;
}
namespace N {
  import state = Source;
  export const tag = state.value;
}
export const value = N.tag;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

/** Sources sharing the write-blocking shape: a mutation reached through a call. */
function loweredWithMutation(body: string): string {
  return lower(`
const helper = { value: 0 };
${body}
export const value = helper.value;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0).at(i).write(value / 10);
  });
});
`);
}

test("a call to a function declared here carries its writes", () => {
  try {
    loweredWithMutation(`function mutate() {\n  helper.value = 1;\n}\nmutate();`);
    expect.unreachable("lower() must see the write the call performs");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callback handed to a call is not deferred", () => {
  try {
    loweredWithMutation(`[0].forEach(() => {\n  helper.value = 1;\n});`);
    expect.unreachable("lower() must see the write inside a callback argument");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an immediately invoked function is not deferred", () => {
  try {
    loweredWithMutation(`(() => {\n  helper.value = 1;\n})();`);
    expect.unreachable("lower() must see the write inside an IIFE");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a called function's parameter shadows the module name", () => {
  const lowered = loweredWithMutation(`
const other = { value: 0 };
function set(helper: { value: number }) {
  helper.value = 1;
}
set(other);
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("following calls terminates on mutual recursion", () => {
  try {
    loweredWithMutation(`
function a() {
  b();
}
function b() {
  a();
  helper.value = 1;
}
a();
`);
    expect.unreachable("lower() must see the write behind a recursive call pair");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callee declared in the calling block is followed", () => {
  try {
    loweredWithMutation(`{\n  const mutate = () => {\n    helper.value = 1;\n  };\n  mutate();\n}`);
    expect.unreachable("lower() must follow a block-local callee");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a function declared in the calling block is followed", () => {
  try {
    loweredWithMutation(`{\n  function mutate() {\n    helper.value = 1;\n  }\n  mutate();\n}`);
    expect.unreachable("lower() must follow a block-local function declaration");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callback passed by name is followed like an inline one", () => {
  try {
    loweredWithMutation(`const mutate = () => {\n  helper.value = 1;\n};\n[0].forEach(mutate);`);
    expect.unreachable("lower() must follow a callback passed by name");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a local name does not borrow the body of an outer one it hides", () => {
  const lowered = loweredWithMutation(`
function mutate() {
  helper.value = 1;
}
void mutate;
{
  const mutate = () => {};
  mutate();
}
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a `var` callee inside a followed function is resolved", () => {
  try {
    loweredWithMutation(`
function outer() {
  var mutate = () => {
    helper.value = 1;
  };
  mutate();
}
outer();
`);
    expect.unreachable("lower() must resolve a function-scoped `var` callee");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a `var` callee inside a class static block is resolved", () => {
  try {
    loweredWithMutation(`
class C {
  static {
    var mutate = () => {
      helper.value = 1;
    };
    mutate();
  }
}
void C;
`);
    expect.unreachable("lower() must resolve a static block's own `var` callee");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a `var` callee nested inside a namespace body is resolved", () => {
  try {
    loweredWithMutation(`
namespace N {
  {
    var mutate = () => {
      helper.value = 1;
    };
  }
  mutate();
}
`);
    expect.unreachable("lower() must resolve a namespace's own `var` callee");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a `var` name does not borrow the body of an outer one it hides", () => {
  const lowered = loweredWithMutation(`
function mutate() {
  helper.value = 1;
}
void mutate;
function outer() {
  var mutate = () => {};
  mutate();
}
outer();
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("`new` runs what the class defers", () => {
  try {
    loweredWithMutation(`
class C {
  f = (helper.value = 1);
  constructor() {
    helper.value = 2;
  }
}
void new C();
`);
    expect.unreachable("lower() must see a constructor's and an instance field's writes");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("`new` on a class expression bound to a name is followed", () => {
  try {
    loweredWithMutation(`
const C = class {
  constructor() {
    helper.value = 1;
  }
};
void new C();
`);
    expect.unreachable("lower() must follow `new` through a named class expression");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("naming a class without `new` runs none of it", () => {
  const lowered = loweredWithMutation(`
class C {
  f = (helper.value = 1);
  constructor() {
    helper.value = 2;
  }
}
void C;
[0].forEach(C as never);
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a callback the callee only stores is not run", () => {
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  void cb;
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a callback the callee calls is run", () => {
  try {
    loweredWithMutation(`
function run(cb: () => void) {
  cb();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must run a callback its callee calls");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callback the callee hands on is run", () => {
  try {
    loweredWithMutation(`
function other(c: () => void) {
  c();
}
function pass(cb: () => void) {
  other(cb);
}
pass(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must run a callback handed on to another call");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callee this file cannot read is assumed to run what it is handed", () => {
  try {
    loweredWithMutation(`[0].forEach(() => {\n  helper.value = 1;\n});`);
    expect.unreachable("lower() must run a callback handed to an unreadable callee");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("`new` runs what every base in the chain defers", () => {
  try {
    loweredWithMutation(`
class Base {
  f = (helper.value = 1);
}
class Middle extends Base {
  constructor() {
    super();
    helper.value = 2;
  }
}
class Derived extends Middle {}
void new Derived();
`);
    expect.unreachable("lower() must construct the bases of a derived class");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callee calling the callback through an alias runs it", () => {
  try {
    loweredWithMutation(`
function run(cb: () => void) {
  const invoke = cb;
  invoke();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must follow a callback called through an alias");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callee handing the callback back can still run it", () => {
  try {
    loweredWithMutation(`
function give(cb: () => void) {
  return cb;
}
give(() => {
  helper.value = 1;
})();
`);
    expect.unreachable("lower() must treat a callback handed back as runnable");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an alias the callee only stores is not run", () => {
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  const kept = cb;
  void kept;
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a concise arrow handing the callback back can run it", () => {
  try {
    loweredWithMutation(`
const give = (cb: () => void) => cb;
give(() => {
  helper.value = 1;
})();
`);
    expect.unreachable("lower() must read a concise arrow body as what it returns");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callback put in a returned object can run", () => {
  try {
    loweredWithMutation(`
function box(cb: () => void) {
  return { run: cb };
}
box(() => {
  helper.value = 1;
}).run();
`);
    expect.unreachable("lower() must treat a callback carried out in an object as runnable");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callback stored on a property can run", () => {
  try {
    loweredWithMutation(`
const store: { cb?: () => void } = {};
function keep(cb: () => void) {
  store.cb = cb;
}
keep(() => {
  helper.value = 1;
});
store.cb?.();
`);
    expect.unreachable("lower() must treat a stored-out callback as runnable");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a bare mention of the callback discards it", () => {
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  cb;
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a property spelled like the callback is not the callback", () => {
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  const o = { cb: 1 };
  void o.cb;
  void cb;
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a name shadowing the callback is not the callback", () => {
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  {
    const cb = () => {};
    cb();
  }
  void cb;
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a `var` in a nested function shadows the callback too", () => {
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  function g() {
    var cb = 1;
    void cb;
  }
  void g;
  void cb;
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("the callback is still seen after a scope that shadowed it", () => {
  try {
    loweredWithMutation(`
function run(cb: () => void) {
  {
    const cb = () => {};
    void cb;
  }
  cb();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must see the outer callback once the shadow ends");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a `var` alias of the callback outlives the block declaring it", () => {
  try {
    loweredWithMutation(`
function run(cb: () => void) {
  {
    var invoke = cb;
  }
  invoke();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must carry a `var` alias past its block");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an alias declared in a block does not outlive it", () => {
  // The outer `invoke` is a different binding, and calling it says nothing.
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  const invoke = () => {};
  {
    const invoke = cb;
    void invoke;
  }
  invoke();
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("an alias assigned to an outer binding outlives the block", () => {
  try {
    loweredWithMutation(`
function run(cb: () => void) {
  let invoke: (() => void) | undefined;
  {
    invoke = cb;
  }
  invoke?.();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must carry an alias assigned to an outer binding");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a callback stored into a binding outside the callee escapes", () => {
  try {
    loweredWithMutation(`
let saved = () => {};
function keep(cb: () => void) {
  saved = cb;
}
keep(() => {
  helper.value = 1;
});
saved();
`);
    expect.unreachable("lower() must treat a store into an outer binding as an escape");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an alias overwritten before the call no longer stands for the callback", () => {
  const lowered = loweredWithMutation(`
function retain(cb: () => void) {
  let invoke = cb;
  invoke = () => {};
  invoke();
}
retain(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("an alias overwritten only in a branch still stands for the callback", () => {
  try {
    loweredWithMutation(`
declare const flag: boolean;
function run(cb: () => void) {
  let invoke = cb;
  if (flag) {
    invoke = () => {};
  }
  invoke();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must keep an alias a branch may not have overwritten");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an alias overwritten only in a loop still stands for the callback", () => {
  try {
    loweredWithMutation(`
declare const times: number;
function run(cb: () => void) {
  let invoke = cb;
  for (let i = 0; i < times; i += 1) {
    invoke = () => {};
  }
  invoke();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must keep an alias a loop may not have overwritten");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an overwrite's right side runs before the name is taken back", () => {
  try {
    loweredWithMutation(`
function run(cb: () => void) {
  let invoke = cb;
  invoke = (invoke(), () => {});
  invoke();
}
run(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must read an overwrite's right side as the old binding");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a constructor's parameter property keeps the callback past the call", () => {
  try {
    loweredWithMutation(`
class Runner {
  constructor(public cb: () => void) {
    this.cb();
  }
}
void new Runner(() => {
  helper.value = 1;
});
`);
    expect.unreachable("lower() must treat a parameter property as keeping the callback");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("a plain constructor parameter that is discarded still hoists", () => {
  const lowered = loweredWithMutation(`
class Ignorer {
  constructor(cb: () => void) {
    void cb;
  }
}
void new Ignorer(() => {
  helper.value = 1;
});
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a callback handed over wrapped is still followed", () => {
  // `.bind`, a conditional, an array — each names the function it hands over.
  for (const argument of ["mutate.bind(null)", "flag ? mutate : noop", "[mutate][0]"]) {
    try {
      loweredWithMutation(`
declare const flag: boolean;
function mutate() {
  helper.value = 1;
}
function noop() {}
function run(cb: () => void) {
  cb();
}
void noop;
run(${argument});
`);
      expect.unreachable(`lower() must follow a callback handed over as ${argument}`);
    } catch (e) {
      expect(e).toBeInstanceOf(LowerError);
      expect((e as LowerError).id).toBe("uwk-export-unsupported");
    }
  }
});

test("a spread decides which indexes into a literal array are still knowable", () => {
  // A spread shifts what comes after it by a length nothing here knows, so an
  // index at or past it names no particular element. Before it, it still does.
  const cases: readonly [string, "hoists" | "refuses"][] = [
    ["[...cbs, mutate][0]", "refuses"],
    ["[...cbs, noop, mutate][1]", "refuses"],
    ["[noop, ...cbs, mutate][0]", "hoists"],
  ];
  for (const [argument, expected] of cases) {
    const source = `
declare const cbs: (() => void)[];
function mutate() {
  helper.value = 1;
}
function noop() {}
function run(cb: () => void) {
  cb();
}
void mutate;
void noop;
run(${argument});
`;
    if (expected === "hoists") {
      const lowered = loweredWithMutation(source);
      expect(lowered.indexOf("export const value"), `${argument} should hoist`).toBeLessThan(
        lowered.indexOf("defineProcessor("),
      );
      continue;
    }
    try {
      loweredWithMutation(source);
      expect.unreachable(`lower() must follow every element for ${argument}`);
    } catch (e) {
      expect(e).toBeInstanceOf(LowerError);
      expect((e as LowerError).id).toBe("uwk-export-unsupported");
    }
  }
});

test("a named property off a literal picks the value that key holds", () => {
  // The last write to a key is the one that lands, so a spread or a computed
  // name clouds the answer only when it comes after the named property.
  const cases: readonly [string, "hoists" | "refuses"][] = [
    ["({ selected: noop, unselected: mutate }).selected", "hoists"],
    ["({ selected: mutate }).selected", "refuses"],
    ["({ mutate, noop }).mutate", "refuses"],
    ["({ selected: noop, ...{ selected: mutate } }).selected", "refuses"],
    ["({ ...{ selected: mutate }, selected: noop }).selected", "hoists"],
    ["({ selected: noop, [key]: mutate }).selected", "refuses"],
    // A literal key in brackets says what a name after a dot says.
    ['({ selected: noop, unselected: mutate })["selected"]', "hoists"],
    ["({ 0: noop, 1: mutate })[0]", "hoists"],
    ["({ selected: noop, unselected: mutate })[key]", "refuses"],
    // A method IS the value its key holds — both what it is not, and what it is.
    ["({ selected() {}, unselected: mutate }).selected", "hoists"],
    ['({ selected() {}, unselected: mutate })["selected"]', "hoists"],
    ["({ selected() { helper.value = 1; } }).selected", "refuses"],
    // An accessor runs code to answer, so what comes back cannot be told — but
    // the answering happens on the read, so what it DOES is seen.
    ["({ get selected() { return noop; }, unselected: mutate }).selected", "hoists"],
    ["({ get selected() { helper.value = 1; return noop; } }).selected", "refuses"],
    ['({ get selected() { helper.value = 1; return noop; } })["selected"]', "refuses"],
    ["({ get other() { helper.value = 1; return noop; }, selected: noop }).selected", "hoists"],
    // Brackets around a literal spell a key as plainly as a bare name does.
    ['({ selected: noop, ["other"]: mutate }).selected', "hoists"],
    ['({ selected: noop, ["selected"]: mutate }).selected', "refuses"],
    ['({ selected: noop, get ["other"]() { helper.value = 1; return noop; } }).selected', "hoists"],
    ['({ get ["selected"]() { helper.value = 1; return noop; } }).selected', "refuses"],
    ["({ selected: noop, get [key]() { helper.value = 1; return noop; } }).selected", "refuses"],
    // A getter answers only until something later takes the key from it, and
    // only the one that answers is read — what it returns included.
    [
      "({ get selected() { helper.value = 1; return mutate; }, selected: noop }).selected",
      "hoists",
    ],
    [
      '({ get selected() { return noop; }, get ["other"]() { return mutate; } }).selected',
      "hoists",
    ],
    ["({ get selected() { return mutate; } }).selected", "refuses"],
    ["({ get selected() { return noop; }, [key]: mutate }).selected", "refuses"],
    // Naming the key takes it — from a doubt, and from a data value.
    ["({ [key]: mutate, get selected() { return noop; } }).selected", "hoists"],
    ["({ [key]: mutate, selected: noop }).selected", "hoists"],
    ["({ selected: mutate, set selected(_v: unknown) {} }).selected", "hoists"],
    ["({ get selected() { return mutate; }, set selected(_v: unknown) {} }).selected", "refuses"],
    ["({ set selected(_v: unknown) {}, get selected() { return mutate; } }).selected", "refuses"],
    // A setter takes only the half it writes, so a getter survives it whatever
    // its name is spelled like — a data value does not.
    [
      "({ get selected() { return noop; }, get [key]() { return mutate; }, set selected(_v: unknown) {} }).selected",
      "refuses",
    ],
    ["({ get [key]() { return mutate; }, set selected(_v: unknown) {} }).selected", "refuses"],
    ["({ [key]: mutate, set selected(_v: unknown) {} }).selected", "hoists"],
    // A name a getter hands back is read where the getter stands.
    [
      "({ get selected() { const local = () => { helper.value = 1; }; return local; } }).selected",
      "refuses",
    ],
    [
      "({ get selected() { if (key) { const local = () => { helper.value = 1; }; return local; } return noop; } }).selected",
      "refuses",
    ],
    ["({ get selected() { const local = () => {}; return local; } }).selected", "hoists"],
  ];
  for (const [argument, expected] of cases) {
    const source = `
declare const key: string;
function mutate() {
  helper.value = 1;
}
function noop() {}
function run(cb: () => void) {
  cb();
}
void mutate;
void noop;
run(${argument});
`;
    if (expected === "hoists") {
      const lowered = loweredWithMutation(source);
      expect(lowered.indexOf("export const value"), `${argument} should hoist`).toBeLessThan(
        lowered.indexOf("defineProcessor("),
      );
      continue;
    }
    try {
      loweredWithMutation(source);
      expect.unreachable(`lower() must follow the mutator in ${argument}`);
    } catch (e) {
      expect(e).toBeInstanceOf(LowerError);
      expect((e as LowerError).id).toBe("uwk-export-unsupported");
    }
  }
});

test("a selected getter runs on the way to the call, whatever the callee does", () => {
  try {
    loweredWithMutation(`
function retain(cb: unknown) {
  void cb;
}
function noop() {}
void noop;
retain(({ get selected() { helper.value = 1; return noop; } }).selected);
`);
    expect.unreachable("lower() must run a getter the argument expression reads");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("what a selected getter returns still depends on the callee", () => {
  const lowered = loweredWithMutation(`
function mutate() {
  helper.value = 1;
}
function retain(cb: unknown) {
  void cb;
}
void mutate;
retain(({ get selected() { return mutate; } }).selected);
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
});

test("a parameter default that calls another parameter runs it", () => {
  try {
    loweredWithMutation(`
function mutate() {
  helper.value = 1;
}
function run(cb: () => void, trigger: unknown = cb()) {
  void trigger;
}
void mutate;
run(mutate);
`);
    expect.unreachable("lower() must see a callback a parameter default calls");
  } catch (e) {
    expect(e).toBeInstanceOf(LowerError);
    expect((e as LowerError).id).toBe("uwk-export-unsupported");
  }
});

test("an argument naming something that is not a function follows nothing", () => {
  const lowered = loweredWithMutation(`
function take(x: unknown) {
  void x;
}
take(helper);
`);
  expect(lowered.indexOf("export const value")).toBeLessThan(lowered.indexOf("defineProcessor("));
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
