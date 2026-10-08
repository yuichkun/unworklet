import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { generateVirtualCode } from "../ide/virtualCode.ts";
import { lower } from "../lower.ts";
import * as programs from "../program.ts";
import { instantiateArgumentConstructors } from "../passes/instantiate.ts";

const emitters = { runtime: lower, virtual: (source: string) => generateVirtualCode(source).code };

for (const [mode, emit] of Object.entries(emitters)) {
  test.each(["f32", "f64", "i32", "bool"])(
    `${mode}: constructs the declared %s argument`,
    (scalar) => {
      const value = scalar === "bool" ? "true" : "0.5";
      const source = `const sg = defineSubgraph((value: Node<"${scalar}">) => ({ tick: () => value }));
const instance = instantiate(sg, ${value});
process(() => {});`;
      expect(emit(source)).toContain(`instantiate(sg, ${scalar}(${value}))`);
    },
  );

  test(`${mode}: preserves Node, primitive alternatives, ambiguous and unsupported targets`, () => {
    const source = `const sg = defineSubgraph((a: Node<"f32">, b: Node<"f32"> | number, c: Node<"f32"> | Node<"f64">, d: Node<"i64">, e: Node<"f32x4">, config: { gain: number }) => ({}));
const instance = instantiate(sg, f32(1), 2, 3, 4, 5, { gain: 6 });
process(() => {});`;
    expect(emit(source)).toContain("instantiate(sg, f32(1), 2, 3, 4, 5, { gain: 6 })");
  });

  test(`${mode}: preserves optional undefined and nullable expressions`, () => {
    const source = `declare const maybe: number | undefined;
const sg = defineSubgraph((a?: Node<"f32">) => ({}));
const a = instantiate(sg);
const b = instantiate(sg, undefined);
const c = instantiate(sg, maybe);
const d = instantiate(sg, 1);
process(() => {});`;
    const code = emit(source);
    expect(code).toContain("instantiate(sg)");
    expect(code).toContain("instantiate(sg, undefined)");
    expect(code).toContain("instantiate(sg, maybe)");
    expect(code).toContain("instantiate(sg, f32(1))");
  });

  test(`${mode}: handles rest arguments and trailing options without wrapping config`, () => {
    const source = `const sg = defineSubgraph((config: number, ...values: Node<"f64">[]) => ({}));
const instance = instantiate(sg, 48000, 1, 2, { name: "voice" });
process(() => {});`;
    expect(emit(source)).toContain('instantiate(sg, 48000, f64(1), f64(2), { name: "voice" })');
  });

  test(`${mode}: follows canonical imported aliases and namespace bindings`, () => {
    const source = `import { instantiate as make } from "@unworklet/core";
import * as core from "@unworklet/core";
const sg = defineSubgraph((a: Node<"i32">) => ({}));
const a = make(sg, 2);
const b = core.instantiate(sg, 3);
process(() => {});`;
    const code = emit(source);
    expect(code).toContain("make(sg, i32(2))");
    expect(code).toContain("core.instantiate(sg, i32(3))");
  });

  test(`${mode}: leaves custom instantiate bindings untouched`, () => {
    const source = `const sg = defineSubgraph((a: Node<"f32">) => ({}));
function instantiate(_sg: unknown, value: number) { return value; }
const a = instantiate(sg, 2);
process(() => {});`;
    expect(emit(source)).toContain("instantiate(sg, 2)");
  });
}

for (const [mode, emit] of Object.entries(emitters)) {
  test(`${mode}: a custom function with the core signature is not the core binding`, () => {
    const source = `import { instantiate as coreInstantiate } from "@unworklet/core";
const instantiate: typeof coreInstantiate = ((_sg: unknown, ...args: unknown[]) => args) as typeof coreInstantiate;
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = instantiate(sg, 2);
process(() => {});`;
    expect(emit(source)).toContain("instantiate(sg, 2)");
  });

  test(`${mode}: preserves nullable declared alternatives and Node-valued sugar`, () => {
    const source = `const nullable = defineSubgraph((a: Node<"f32"> | null) => ({}));
const numberConfig = defineSubgraph((a: Node<"f32"> | 3) => ({}));
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = instantiate(nullable, null);
const b = instantiate(numberConfig, 3);
const c = instantiate(sg, f32(1) + 2);
process(() => {});`;
    const code = emit(source);
    expect(code).toContain("instantiate(nullable, null)");
    expect(code).toContain("instantiate(numberConfig, 3)");
    expect(code).toContain("instantiate(sg, add(f32(1), 2))");
  });

  test(`${mode}: wraps a numeric expression once without wrapping its callee`, () => {
    const source = `const sg = defineSubgraph((a: Node<"f32">) => ({}));
function nextValue(): number { return 1; }
const a = instantiate(sg, nextValue());
process(() => {});`;
    expect(emit(source)).toContain("instantiate(sg, f32(nextValue()))");
  });
}

for (const [mode, emit] of Object.entries(emitters)) {
  test(`${mode}: generic, broad and partially known inputs remain explicit`, () => {
    const source = `import type { SubgraphDecl } from "@unworklet/core";
declare const anyValue: any;
declare const unknownValue: unknown;
declare const maybeNode: Node<"f32"> | number;
declare const generic: SubgraphDecl<unknown[], {}>;
declare const ambiguous: SubgraphDecl<[Node<"f32">], {}> | SubgraphDecl<[Node<"f64">], {}>;
const broad = defineSubgraph((a: Node) => ({}));
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = instantiate(sg, anyValue);
const b = instantiate(sg, unknownValue);
const c = instantiate(sg, maybeNode);
const d = instantiate(generic, 1);
const e = instantiate(ambiguous, 2);
const f = instantiate(broad, 3);
process(() => {});`;
    const code = emit(source);
    for (const call of [
      "sg, anyValue",
      "sg, unknownValue",
      "sg, maybeNode",
      "generic, 1",
      "ambiguous, 2",
      "broad, 3",
    ]) {
      expect(code).toContain(`instantiate(${call})`);
    }
  });

  test(`${mode}: does not shift argument slots after a spread or nonterminal rest`, () => {
    const source = `import type { SubgraphDecl } from "@unworklet/core";
const sg = defineSubgraph((a: Node<"f32">, b: Node<"i32">) => ({}));
declare const values: [number];
declare const tail: SubgraphDecl<[...Node<"f64">[], Node<"i32">], {}>;
const a = instantiate(sg, ...values, 2);
const b = instantiate(tail, 1, 2);
process(() => {});`;
    const code = emit(source);
    expect(code).toContain("instantiate(sg, ...values, 2)");
    expect(code).toContain("instantiate(tail, 1, 2)");
  });

  test(`${mode}: constructor helper references cannot be captured by authored bindings`, () => {
    const source = `const f32 = (x: number) => x + 99;
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = instantiate(sg, 2);
process(() => {});`;
    expect(emit(source)).toContain("instantiate(sg, __uwk_f32(2))");
  });
}

for (const [mode, emit] of Object.entries(emitters)) {
  test(`${mode}: a custom object typed as the core namespace is not a core import`, () => {
    const source = `import * as core from "@unworklet/core";
const fake: typeof core = { ...core, instantiate: ((_sg: unknown, value: unknown) => value) as typeof core.instantiate };
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = fake.instantiate(sg, 2);
process(() => {});`;
    expect(emit(source)).toContain("fake.instantiate(sg, 2)");
  });
}

test("virtual constructor glue preserves authored expression mappings", () => {
  const source = `const sg = defineSubgraph((a: Node<"f32">) => ({}));
function nextValue(): number { return 1; }
const a = instantiate(sg, nextValue());
process(() => {});`;
  const result = generateVirtualCode(source);
  let constructorAnchors = 0;
  for (const mapping of result.mappings) {
    const start = mapping.generatedOffsets[0]!;
    if (mapping.generatedLengths !== undefined) {
      if (result.code.slice(start, start + mapping.generatedLengths[0]!) === "f32(")
        constructorAnchors++;
      expect(mapping.lengths).toEqual([0]);
      expect(mapping.data.navigation).toBeUndefined();
      expect(mapping.data.verification).toBe(true);
    } else {
      const offset = mapping.sourceOffsets[0]!;
      const length = mapping.lengths[0]!;
      expect(result.code.slice(start, start + length)).toBe(source.slice(offset, offset + length));
    }
  }
  expect(constructorAnchors).toBe(1);
  const offset = source.lastIndexOf("nextValue()");
  const mapped = result.mappings.find(
    (mapping) =>
      mapping.generatedLengths === undefined &&
      mapping.sourceOffsets[0]! <= offset &&
      offset < mapping.sourceOffsets[0]! + mapping.lengths[0]!,
  );
  expect(mapped?.data.navigation).toBe(true);
});

test("files without canonical calls do not build a null-aware program", () => {
  const source = `function instantiate(value: number) { return value; }
const a = instantiate(2);
process(() => {});`;
  const original = programs.buildProgram(source);
  const build = vi.spyOn(programs, "buildProgram");
  try {
    expect(instantiateArgumentConstructors(source, original).size).toBe(0);
    expect(build).not.toHaveBeenCalled();
  } finally {
    build.mockRestore();
  }
});

test("eligible calls change only the null-check option of their separate query", () => {
  const source = `const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = instantiate(sg, 2);
process(() => {});`;
  const original = programs.buildProgram(source);
  const build = vi.spyOn(programs, "buildProgram");
  try {
    expect(instantiateArgumentConstructors(source, original).size).toBe(1);
    expect(build).toHaveBeenCalledExactlyOnceWith(source, { strictNullChecks: true });
    expect(original.program.getCompilerOptions().strictNullChecks).toBe(false);
    const precise = build.mock.results[0]!.value as programs.BuiltProgram;
    expect(precise.program.getCompilerOptions()).toEqual({
      ...original.program.getCompilerOptions(),
      strictNullChecks: true,
    });
  } finally {
    build.mockRestore();
  }
});

for (const [mode, emit] of Object.entries(emitters)) {
  test(`${mode}: parenthesized canonical calls lower but conditional callees stay unchanged`, () => {
    const source = `const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = (instantiate)(sg, 2);
const b = (true ? instantiate : instantiate)(sg, 3);
process(() => {});`;
    const code = emit(source);
    expect(code).toContain("(instantiate)(sg, f32(2))");
    expect(code).toContain("(true ? instantiate : instantiate)(sg, 3)");
  });

  test(`${mode}: unresolved generic argument tuples are not reinterpreted`, () => {
    const source = `import type { SubgraphDecl } from "@unworklet/core";
function make<Args extends unknown[]>(graph: SubgraphDecl<Args, {}>) {
  return instantiate(graph, 1 as any);
}
process(() => {});`;
    expect(emit(source)).toContain("instantiate(graph, 1 as any)");
  });
}

test("an unavailable core module leaves argument construction unresolved", () => {
  const source = "instantiate(graph, 1);";
  const snapshot = programs.emptySnapshot();
  const original = programs.buildProgram(source, { snapshot });
  expect(instantiateArgumentConstructors(source, original, { snapshot }).size).toBe(0);
});

for (const [mode, emit] of Object.entries(emitters)) {
  test(`${mode}: chained noncanonical calls cannot replace inner argument plans`, () => {
    const source = `const sg = defineSubgraph((x: Node<"f32">) => ({}));
const factory = defineSubgraph((n: number) => ({ fn: (graph: unknown, x: number) => n }));
const a = instantiate(factory, 7).fn(sg, 2);
process(() => {});`;
    expect(emit(source)).toContain("instantiate(factory, 7).fn(sg, 2)");
  });

  test(`${mode}: different chained call arities do not index another call's arguments`, () => {
    const source = `const sg = defineSubgraph((x: Node<"f32">, y: Node<"i32">) => ({}));
const factory = defineSubgraph(() => ({ fn: (graph: unknown, x: number, y: number) => 1 }));
const a = instantiate(factory).fn(sg, 2, 3);
process(() => {});`;
    expect(emit(source)).toContain("instantiate(factory).fn(sg, 2, 3)");
  });

  test(`${mode}: nested canonical calls receive their own argument constructors once`, () => {
    const source = `const inner = defineSubgraph((x: Node<"f64">) => ({ value: () => 2 }));
const outer = defineSubgraph((x: Node<"f32">) => ({}));
const a = instantiate(outer, instantiate(inner, 3).value());
process(() => {});`;
    expect(emit(source)).toContain("instantiate(outer, f32(instantiate(inner, f64(3)).value()))");
  });
}

for (const [mode, emit] of Object.entries(emitters)) {
  test(`${mode}: parenthesized namespace receivers keep their actual import binding`, () => {
    const source = `import * as core from "@unworklet/core";
const fake: typeof core = { ...core, instantiate: ((_sg: unknown, value: unknown) => value) as typeof core.instantiate };
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = (core).instantiate(sg, 2);
const b = ((core)).instantiate(sg, 3);
const c = (fake).instantiate(sg, 4);
process(() => {});`;
    const code = emit(source);
    expect(code).toContain("(core).instantiate(sg, f32(2))");
    expect(code).toContain("((core)).instantiate(sg, f32(3))");
    expect(code).toContain("(fake).instantiate(sg, 4)");
  });
}

const bindingWrappers = [
  ["nested parentheses", (name: string) => `((${name}))`],
  ["non-null", (name: string) => `${name}!`],
  ["as", (name: string) => `(${name} as typeof ${name})`],
  ["type assertion", (name: string) => `(<typeof ${name}>${name})`],
  ["satisfies", (name: string) => `(${name} satisfies typeof ${name})`],
  ["mixed", (name: string) => `((${name}! as typeof ${name}) satisfies typeof ${name})`],
] as const;

for (const [mode, emit] of Object.entries(emitters)) {
  test.each(bindingWrappers)(`${mode}: %s wrappers preserve binding proof`, (_, wrap) => {
    const source = `import * as core from "@unworklet/core";
import { instantiate as make } from "@unworklet/core";
const fakeCall = ((_sg: unknown, value: unknown) => value) as typeof make;
const fake: typeof core = { ...core, instantiate: fakeCall };
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = ${wrap("make")}(sg, 2);
const b = ${wrap("core")}.instantiate(sg, 3);
const c = ${wrap("fakeCall")}(sg, 4);
const d = ${wrap("fake")}.instantiate(sg, 5);
process(() => {});`;
    const code = emit(source);
    expect(code).toMatch(/\(sg, f32\(2\)\)/);
    expect(code).toMatch(/\.instantiate\(sg, f32\(3\)\)/);
    expect(code).toMatch(/\(sg, 4\)/);
    expect(code).toMatch(/\.instantiate\(sg, 5\)/);
  });
}

for (const [mode, emit] of Object.entries(emitters)) {
  test(`${mode}: type-instantiated callees retain their underlying binding identity`, () => {
    const source = `import { instantiate as make } from "@unworklet/core";
const fakeCall = ((_sg: unknown, value: unknown) => value) as typeof make;
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = (make<[Node<"f32">], {}>)(sg, 2);
const b = (fakeCall<[Node<"f32">], {}>)(sg, 3);
process(() => {});`;
    const code = emit(source);
    expect(code).toContain("(sg, f32(2))");
    expect(code).toContain("(sg, 3)");
  });
}

for (const mode of ["runtime", "virtual"]) {
  test(`${mode}: asserted namespace types cannot replace the receiver module's exports`, () => {
    const root = mkdtempSync(path.join(import.meta.dirname, "../../.instantiate-binding-"));
    try {
      writeFileSync(
        path.join(root, "forward.ts"),
        'export { instantiate } from "@unworklet/core";',
      );
      writeFileSync(
        path.join(root, "fake.ts"),
        "export const instantiate = (_graph: unknown, value: unknown) => value;",
      );
      writeFileSync(
        path.join(root, "typed.ts"),
        'import { instantiate as coreInstantiate } from "@unworklet/core"; export const instantiate = ((_graph: unknown, value: unknown) => value) as typeof coreInstantiate;',
      );
      const source = `import * as core from "@unworklet/core";
import * as forwarded from "./forward.ts";
import * as fake from "./fake.ts";
import * as typed from "./typed.ts";
const sg = defineSubgraph((a: Node<"f32">) => ({}));
const a = (core as unknown as typeof core).instantiate(sg, 1);
const b = (forwarded as unknown as typeof core).instantiate(sg, 2);
const c = (fake as unknown as typeof core).instantiate(sg, 3);
const d = typed.instantiate(sg, 4);
const e = (typed as unknown as typeof core).instantiate(sg, 5);
const f = (core as { instantiate: typeof core.instantiate }).instantiate(sg, 6);
const g = (fake as unknown as { instantiate: typeof core.instantiate }).instantiate(sg, 7);
process(() => {});`;
      const snapshot = programs.emptySnapshot();
      const runtime = lower(source, {
        sourcePath: path.join(root, "main.uwk.ts"),
        captureInto: snapshot,
      });
      const code = mode === "runtime" ? runtime : generateVirtualCode(source, { snapshot }).code;
      expect(code).toContain(".instantiate(sg, f32(1))");
      expect(code).toContain(".instantiate(sg, f32(2))");
      expect(code).toContain(".instantiate(sg, 3)");
      expect(code).toContain(".instantiate(sg, 4)");
      expect(code).toContain(".instantiate(sg, 5)");
      expect(code).toContain(".instantiate(sg, f32(6))");
      expect(code).toContain(".instantiate(sg, 7)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
