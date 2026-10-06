import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderOffline } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import { captureFsSnapshot } from "./capture.ts";
import { lowerToProcessor } from "./eval-lowered.ts";
import { expectSameLowering } from "./goldenHarness.ts";
import { loadUwkProcessor } from "./index.ts";
import { lower } from "./lower.ts";

const config = { sampleRate: 48000, duration: 128 / 48000 };
const mono = (declarations: string, body: string): string => `${declarations}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { ${body} }); });`;
const product = "out.ch(0)[i] = f32(0.5) * f32(2);";
const explicit = mono("", "out.ch(0).at(i).write(f32(0.5).mul(f32(2)));");

test.each([
  ["top-level variable", "const mul = (a: number, b: number) => a + b;", product],
  ["function declaration", "function mul(a: number, b: number) { return a + b; }", product],
  ["process-local variable", "", `const mul = () => 99; ${product}`],
  ["nested block", "", `{ const mul = () => 99; ${product} }`],
  ["parameter", "", `((mul: number) => { ${product} })(99);`],
  ["destructuring", "", `const { local: mul } = { local: 99 }; ${product}`],
  ["array", "", `const [mul] = [99]; ${product}`],
  ["catch", "", `try { throw 99; } catch (mul) { ${product} }`],
  ["loop", "", `for (let mul = 0; mul < 1; mul++) { ${product} }`],
  ["named function expression", "", `(function mul() { ${product} })();`],
  ["named class expression", "", `new (class mul { constructor() { ${product} } })();`],
  ["enum", "enum mul { ignored = 99 }", product],
  ["namespace", "namespace mul { export const ignored = 99; }", product],
  ["core import alias", 'import { add as mul } from "@unworklet/core";', product],
])("generated multiplication ignores the %s binding", async (_name, declarations, body) => {
  const source = mono(declarations, body);
  await expectSameLowering(source, explicit);
  const result = await renderOffline(lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(1));
});

test("explicit calls and generated aliases keep their authored bindings", async () => {
  const source = mono(
    `const mul = (a: number, b: number) => a + b;
const __uwk_mul = 10;
const __uwk_mul_1 = 20;`,
    `const __uwk_mul_2 = 30;
out.ch(0)[i] = f32(mul(0.5, 2) + __uwk_mul + __uwk_mul_1 + __uwk_mul_2) + f32(0.5) * f32(2);`,
  );
  const lowered = lower(source);
  expect(lowered).toContain("mul(0.5, 2)");
  expect(lowered).toContain("const __uwk_mul = 10");
  expect(lowered).toContain("const __uwk_mul_1 = 20");
  const result = await renderOffline(lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(63.5));
});

test("all generated operator helpers are independent of local names", async () => {
  const source = mono(
    `const add = 0, sub = 0, mul = 0, div = 0, mod = 0, pow = 0;
const lt = 0, gt = 0, lte = 0, gte = 0, eq = 0, and = 0, or = 0;
const neg = 0, not = 0, select = 0;`,
    `const a = f32(2), b = f32(1);
const arithmetic = ((a + b) * a - b) / b % f32(4) ** b;
const condition = a > b && a >= b && b < a && b <= a && a != b && a !== b && a == a && a === a || bool(false);
out.ch(0)[i] = !condition ? f32(99) : -arithmetic;`,
  );
  const result = await renderOffline(lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(-1));
});

test("if-sugar select and feedback state helpers ignore nested bindings", async () => {
  const source = mono(
    `const sg = defineSubgraph(() => {
  const state = 99;
  const __prev_0 = 10;
  return { tick: (__r: Node<"f32">) => __r + $prev };
});
const instance = instantiate(sg);
const value = state.f32(0);`,
    `const select = 99;
if (i < i32(64)) value.write(instance.tick(f32(1)));
out.ch(0)[i] = value;`,
  );
  const result = await renderOffline(lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(
    Array.from({ length: 128 }, (_, i) => Math.min(i + 1, 64)),
  );
});

test("snapshot and built browser lowering preserve helper bindings", async () => {
  const source = mono("const mul = () => 99;", product);
  const snapshot = captureFsSnapshot();
  const replayed = await renderOffline(lowerToProcessor(source, snapshot), config);
  expect([...replayed.outputs.main[0]!]).toEqual(Array(128).fill(1));
  const browserEntry = path.resolve(import.meta.dirname, "../dist/browser.mjs");
  const browser = (await import(/* @vite-ignore */ browserEntry)) as {
    lowerToProcessor: typeof lowerToProcessor;
  };
  const result = await renderOffline(browser.lowerToProcessor(source), config);
  expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(1));
});

test("library and processor imports preserve user helpers through materialization", async () => {
  const directory = mkdtempSync(path.join(import.meta.dirname, "../.generated-names-"));
  try {
    writeFileSync(path.join(directory, "helper.ts"), "export const mul = () => 0.25;");
    writeFileSync(
      path.join(directory, "gain.uwk.ts"),
      `import { mul } from "./helper.ts";
export const gain = defineSubgraph(() => ({ tick: (x: Node<"f32">) => x * f32(mul()) }));`,
    );
    const entry = path.join(directory, "main.uwk.ts");
    writeFileSync(
      entry,
      mono(
        `import { mul } from "./helper.ts";
import { gain } from "./gain.uwk.ts";
const instance = instantiate(gain);`,
        "out.ch(0)[i] = instance.tick(f32(2)) * f32(mul());",
      ),
    );
    const result = await renderOffline(await loadUwkProcessor(entry), config);
    expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(0.125));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("helper collisions do not mask unrelated lowering errors", () => {
  expect(() => lower(mono("const select = 0;", "if (bool(true)) { f32(1); }"))).toThrow(
    expect.objectContaining({ id: "uwk-unsupported-if" }),
  );
});

test("generated import aliases do not collide with the requested processor export", async () => {
  const directory = mkdtempSync(path.join(import.meta.dirname, "../.generated-export-"));
  try {
    const file = path.join(directory, "processor.ts");
    writeFileSync(file, lower(mono("const mul = () => 99;", product), { exportName: "__uwk_mul" }));
    const exported = (await import(/* @vite-ignore */ file)) as {
      __uwk_mul: ReturnType<typeof lowerToProcessor>;
    };
    const result = await renderOffline(exported.__uwk_mul, config);
    expect([...result.outputs.main[0]!]).toEqual(Array(128).fill(1));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
