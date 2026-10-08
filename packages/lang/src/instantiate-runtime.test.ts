import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CompiledProcessor } from "@unworklet/core";
import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import { captureFsSnapshot, loadUwkProcessor, lowerToProcessor } from "./index.ts";

const config = { sampleRate: 48000, duration: 128 / 48000 };
const snapshot = captureFsSnapshot();
const mono = (declarations: string, value: string): string => `${declarations}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0).at(i).write(${value}); }); });`;

async function expectSamples(
  processor: CompiledProcessor<unknown>,
  expected: number,
): Promise<void> {
  const rendered = await renderOffline(processor, config);
  expect([...rendered.outputs.main[0]!]).toEqual(Array.from({ length: 128 }, () => expected));
}

for (const mode of ["Node", "browser snapshot"] as const) {
  const lower = (source: string): CompiledProcessor<unknown> =>
    lowerToProcessor(source, mode === "browser snapshot" ? snapshot : undefined);

  test.each([
    ["method", "value.mul(2)", "instance.tick()"],
    ["operator", "value * 2", "instance.tick()"],
    ["pass-through", "value", "instance.tick().mul(2)"],
  ])(`${mode}: a bare f32 argument renders through a %s subgraph`, async (_, body, value) => {
    const processor = lower(
      mono(
        `
const graph = defineSubgraph((value: Node<"f32">) => ({ tick: () => ${body} }));
const instance = instantiate(graph, 0.25);`,
        value,
      ),
    );
    await expectSamples(processor, 0.5);
  });

  test.each([
    ["f32", "16777217", "f64(value).sub(f64(16777216))", 0],
    ["f64", "16777217", "value.sub(f64(16777216))", 1],
    ["i32", "4294967299.75", "value.add(i32(1))", 4],
    ["i32", "-3.75", "value.add(i32(1))", -2],
    ["bool", "true", "select(value.not(), f32(2), f32(1))", 1],
    ["bool", "false", "select(value.not(), f32(2), f32(1))", 2],
  ] as const)(
    `${mode}: %s(%s) uses the declared scalar semantics`,
    async (type, argument, body, expected) => {
      const processor = lower(
        mono(
          `
const graph = defineSubgraph((value: Node<"${type}">) => ({ tick: () => f32(${body}) }));
const instance = instantiate(graph, ${argument});`,
          "instance.tick()",
        ),
      );
      await expectSamples(processor, expected);
    },
  );

  test.each([
    ["f64", "1e8", "(value + 1) - value", 1],
    ["i32", "1.75", "value + 1", 2],
    ["f64", "1e8", "(f32(value) + 1) - f32(value)", 0],
    ["f32", "1.75", "value + 1", 2.75],
  ] as const)(
    `${mode}: declared %s arithmetic for %s through %s renders %s`,
    async (scalar, argument, expression, expected) => {
      const processor = lower(
        mono(
          `const graph = defineSubgraph((value: Node<"${scalar}">) => ({ tick: () => ${expression} }));
const instance = instantiate(graph, ${argument});`,
          "f32(instance.tick())",
        ),
      );
      await expectSamples(processor, expected);
    },
  );

  test(`${mode}: parenthesized namespace receivers construct method-form arguments`, async () => {
    const processor = lower(
      mono(
        `import * as core from "@unworklet/core";
const graph = defineSubgraph((value: Node<"f32">) => ({ tick: (x: Node<"f32">) => value.add(x) }));
const instance = ((core)).instantiate(graph, 0.5);`,
        "instance.tick(f32(1))",
      ),
    );
    await expectSamples(processor, 1.5);
  });

  test(`${mode}: transparent callee and receiver wrappers preserve canonical and custom calls`, async () => {
    const wrap = [
      (name: string) => `((${name}))`,
      (name: string) => `${name}!`,
      (name: string) => `(${name} as typeof ${name})`,
      (name: string) => `(<typeof ${name}>${name})`,
      (name: string) => `(${name} satisfies typeof ${name})`,
      (name: string) => `((${name}! as typeof ${name}) satisfies typeof ${name})`,
    ];
    const calls = wrap.flatMap((wrapper) => [
      `${wrapper("make")}(graph, 0.5)`,
      `${wrapper("core")}.instantiate(graph, 0.5)`,
      `${wrapper("fakeCall")}(graph, 0.5)`,
      `${wrapper("fake")}.instantiate(graph, 0.5)`,
    ]);
    const processor = lower(
      mono(
        `import * as core from "@unworklet/core";
import { instantiate as make } from "@unworklet/core";
const fakeCall = ((_graph: unknown, value: number) => {
  if (typeof value !== "number") throw new Error("custom call received a Node");
  return { tick: (_x: Node<"f32">) => f32(value) };
}) as typeof make;
const fake: typeof core = { ...core, instantiate: fakeCall };
const graph = defineSubgraph((value: Node<"f32">) => ({ tick: (x: Node<"f32">) => value.add(x) }));
${calls.map((call, i) => `const instance${i} = ${call};`).join("\n")}`,
        calls
          .map((_, i) => `instance${i}.tick(f32(1))`)
          .reduce((sum, value) => `${sum}.add(${value})`, "f32(0)"),
      ),
    );
    await expectSamples(processor, 24);
  });

  test(`${mode}: broad assertions preserve proven calls and custom arguments`, async () => {
    const processor = lower(
      mono(
        `import * as core from "@unworklet/core";
import { instantiate as make } from "@unworklet/core";
const fakeCall = ((_graph: unknown, value: number) => {
  if (typeof value !== "number") throw new Error("custom call received a Node");
  return { tick: () => f32(value) };
}) as typeof make;
const fake: typeof core = { ...core, instantiate: fakeCall };
const graph = defineSubgraph((value: Node<"f32">) => ({ tick: () => value.add(1) }));
const a = (make as any)(graph, 1);
const b = (make as unknown as (...args: any[]) => any)(graph, 2);
const c = (instantiate as any)(graph, 3);
const d = (core as any).instantiate(graph, 4);
const e = (core as unknown as { instantiate: (...args: any[]) => any }).instantiate(graph, 5);
const f = (fakeCall as any)(graph, 6);
const g = (fake as unknown as { instantiate: (...args: any[]) => any }).instantiate(graph, 7);`,
        "a.tick().add(b.tick()).add(c.tick()).add(d.tick()).add(e.tick()).add(f.tick()).add(g.tick())",
      ),
    );
    await expectSamples(processor, 33);
  });

  test(`${mode}: argument expressions evaluate once and existing Node identity is retained`, async () => {
    const processor = lower(
      mono(
        `
const calls = { count: 0 };
function nextValue(): number { calls.count += 1; return 0.25; }
const original = f32(0.5);
const identities = new WeakMap<object, number>();
identities.set(original, 1);
const graph = defineSubgraph((value: Node<"f32">, existing: Node<"f32">) => {
  if (identities.get(existing) !== 1) throw new Error("Node identity was replaced");
  return { tick: () => value.add(existing) };
});
const before = calls.count;
const instance = instantiate(graph, nextValue(), original);
const evaluations = calls.count - before;`,
        "instance.tick().add(evaluations)",
      ),
    );
    await expectSamples(processor, 1.75);
  });

  test(`${mode}: chained calls preserve primitive subgraph config and method arguments`, async () => {
    const processor = lower(
      mono(
        `
const sg = defineSubgraph((value: Node<"f32">) => ({ tick: () => value.mul(2) }));
const factory = defineSubgraph((n: number) => {
  if (typeof n !== "number") throw new Error("primitive subgraph config was lifted");
  return { fn: (graph: unknown, x: number) => {
    if (typeof x !== "number") throw new Error("primitive method argument was lifted");
    return n;
  } };
});
const value = instantiate(factory, 7).fn(sg, 2);
if (typeof value !== "number") throw new Error("primitive method result was lifted");`,
        "value",
      ),
    );
    await expectSamples(processor, 7);
  });

  test(`${mode}: a chained method with more arguments than instantiate captures and renders`, async () => {
    const processor = lower(
      mono(
        `
const sg = defineSubgraph((value: Node<"f32">) => ({ tick: () => value.mul(2) }));
const factory = defineSubgraph(() => ({ fn: (graph: unknown, x: number, y: number) => {
  if (typeof x !== "number" || typeof y !== "number") throw new Error("primitive method arguments were lifted");
  return 1;
} }));
const value = instantiate(factory).fn(sg, 2, 3);
if (typeof value !== "number") throw new Error("primitive method result was lifted");`,
        "value",
      ),
    );
    await expectSamples(processor, 1);
  });

  test(`${mode}: optional values preserve omission and explicit undefined`, async () => {
    const processor = lower(
      mono(
        `
const graph = defineSubgraph((value?: Node<"f32">) => {
  const selected = value ?? f32(0.125);
  return { tick: () => selected.mul(2) };
});
const omitted = instantiate(graph);
const explicitUndefined = instantiate(graph, undefined);
const supplied = instantiate(graph, 0.25);`,
        "omitted.tick().add(explicitUndefined.tick()).add(supplied.tick())",
      ),
    );
    await expectSamples(processor, 1);
  });

  test(`${mode}: mixed config, scalar rest arguments and trailing options retain their meaning`, async () => {
    const processor = lower(
      mono(
        `
const config = { name: "configuration", offset: 0.125 };
const identities = new WeakMap<object, number>();
identities.set(config, 1);
const graph = defineSubgraph((settings: { name: string; offset: number }, multiplier: number, ...values: Node<"f32">[]) => {
  if (identities.get(settings) !== 1 || typeof multiplier !== "number") throw new Error("config changed");
  if (values.length !== 2) throw new Error("options leaked into the rest arguments");
  const offset = state.f32(settings.offset).named("offset");
  return { tick: () => values[0].add(values[1]).mul(multiplier).add(offset.read()) };
});
const instance = instantiate(graph, config, 2, 0.25, 0.5, { name: "voice" });`,
        "instance.tick()",
      ),
    );
    expect(processor.graph).toMatchObject({
      declarations: expect.arrayContaining([expect.objectContaining({ name: "voice/offset" })]),
    });
    await expectSamples(processor, 1.625);
  });
}

test.each(["named", "namespace"])(
  "loadUwkProcessor follows cross-file %s aliases",
  async (style) => {
    const root = mkdtempSync(path.join(import.meta.dirname, "..", ".instantiate-runtime-"));
    try {
      writeFileSync(
        path.join(root, "gain.uwk.ts"),
        `
export const gain = defineSubgraph((value: Node<"f32">) => ({ tick: () => value.mul(2) }));`,
      );
      writeFileSync(
        path.join(root, "barrel.uwk.ts"),
        'export { gain as amplitude } from "./gain.uwk.ts";',
      );
      const imports =
        style === "named"
          ? 'import { amplitude as graph } from "./barrel.uwk.ts";\nimport { instantiate as create } from "@unworklet/core";'
          : 'import * as graphs from "./barrel.uwk.ts";\nimport * as core from "@unworklet/core";';
      const call =
        style === "named" ? "create(graph, 0.375)" : "core.instantiate(graphs.amplitude, 0.375)";
      const file = path.join(root, "main.uwk.ts");
      writeFileSync(file, mono(`${imports}\nconst instance = ${call};`, "instance.tick()"));
      await expectSamples(await loadUwkProcessor(file), 0.75);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("loadUwkProcessor proves real namespace exports despite asserted core types", async () => {
  const root = mkdtempSync(path.join(import.meta.dirname, "../.instantiate-runtime-"));
  try {
    writeFileSync(path.join(root, "forward.ts"), 'export { instantiate } from "@unworklet/core";');
    const body = `(_graph: unknown, value: number) => {
  if (typeof value !== "number") throw new Error("custom namespace received a Node");
  return { tick: () => f32(value) };
}`;
    writeFileSync(
      path.join(root, "fake.ts"),
      `import { f32 } from "@unworklet/core"; export const instantiate = ${body};`,
    );
    writeFileSync(
      path.join(root, "typed.ts"),
      `import { f32, instantiate as coreInstantiate } from "@unworklet/core"; export const instantiate = (${body}) as typeof coreInstantiate;`,
    );
    const file = path.join(root, "main.uwk.ts");
    writeFileSync(
      file,
      mono(
        `import * as core from "@unworklet/core";
import * as forwarded from "./forward.ts";
import * as fake from "./fake.ts";
import * as typed from "./typed.ts";
const graph = defineSubgraph((value: Node<"f32">) => ({ tick: () => value.add(1) }));
const a = (core as unknown as typeof core).instantiate(graph, 1);
const b = (forwarded as unknown as typeof core).instantiate(graph, 2);
const c = (fake as unknown as typeof core).instantiate(graph, 3);
const d = typed.instantiate(graph, 4);
const e = (typed as unknown as typeof core).instantiate(graph, 5);
const f = (core as { instantiate: typeof core.instantiate }).instantiate(graph, 6);
const g = (fake as unknown as { instantiate: typeof core.instantiate }).instantiate(graph, 7);
const h = (core as unknown as { instantiate: (...args: any[]) => any }).instantiate(graph, 8);
const broadCustom = (fake as unknown as { instantiate: (...args: any[]) => any }).instantiate(graph, 9);`,
        "a.tick().add(b.tick()).add(c.tick()).add(d.tick()).add(e.tick()).add(f.tick()).add(g.tick()).add(h.tick()).add(broadCustom.tick())",
      ),
    );
    await expectSamples(await loadUwkProcessor(file), 49);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
