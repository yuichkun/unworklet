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
