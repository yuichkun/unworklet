import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, test, vi } from "vite-plus/test";

import {
  deriveExportName,
  importLoweredEntry,
  isUwkSource,
  loadUwkProcessor,
  lowerUwkSource,
  materializeLowered,
  NotAProcessorError,
} from "./materialize-lowered.ts";

const dirs: string[] = [];
const fixtures = (): string => {
  const dir = mkdtempSync(path.join(import.meta.dirname, "../.mat-boundary-"));
  dirs.push(dir);
  return dir;
};
const processor = (imports = "", value = "0.25"): string => `${imports}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0)[i] = ${value}; }); });`;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

test("source classification and fallback identifiers cover file names without identifier characters", () => {
  expect(isUwkSource("voice.uwk.ts")).toBe(true);
  expect(isUwkSource("voice.processor.ts")).toBe(false);
  expect(deriveExportName("123.uwk.ts")).toBe("processor");
  expect(deriveExportName("---.uwk.ts")).toBe("processor");
  expect(deriveExportName("/voice/noise_drive.uwk.ts")).toBe("noiseDrive");
});

test("a completed dependency is materialized once within one load", async () => {
  const dir = fixtures();
  const file = path.join(dir, "synth.uwk.ts");
  writeFileSync(file, processor());
  const done = new Map<string, string>();
  const pending = new Set<string>();
  const cleanup: string[] = [];
  const first = await materializeLowered(file, done, pending, cleanup);
  const second = await materializeLowered(file, done, pending, cleanup);
  expect(second).toBe(first);
  expect(cleanup).toEqual([first]);
  expect(pending.size).toBe(0);
});

test("shared helpers, parent-directory imports and query fragments preserve their paths", async () => {
  const dir = fixtures();
  mkdirSync(path.join(dir, "nested"));
  writeFileSync(path.join(dir, "base.mjs"), "export const GAIN = 0.5;");
  writeFileSync(path.join(dir, "left.mjs"), 'export { GAIN } from "./base.mjs";');
  writeFileSync(path.join(dir, "right.mjs"), 'export { GAIN } from "./base.mjs";');
  const file = path.join(dir, "nested/synth.uwk.ts");
  writeFileSync(
    file,
    processor(
      'import { GAIN } from "../left.mjs?custom=1#tag#part";\nimport { GAIN as other } from "../right.mjs";',
      "GAIN + other",
    ),
  );
  const cleanup: string[] = [];
  const temp = await materializeLowered(file, new Map(), new Set(), cleanup);
  expect(readFileSync(temp, "utf8")).toMatch(/\.\.\/left\.mjs\?custom=1&uwkrev=[0-9a-f]+#tag#part/);
  const module = await importLoweredEntry(temp, file);
  expect(module.synth).toHaveProperty("graph");
  expect(module.synth).toHaveProperty("schemaHash", expect.any(String));
  writeFileSync(path.join(dir, "base.mjs"), "export const GAIN = 0.75;");
  await expect(loadUwkProcessor(file)).rejects.toThrow(/base\.mjs changed.*another helper/s);
});

test("a missing helper is reported by module loading and temp files are cleaned", async () => {
  const dir = fixtures();
  const file = path.join(dir, "synth.uwk.ts");
  writeFileSync(file, processor('import { GAIN } from "./missing.mjs";', "GAIN"));
  await expect(loadUwkProcessor(file)).rejects.toThrow(/missing\.mjs/);
  expect(readdirSync(dir)).toEqual(["synth.uwk.ts"]);
});

test("an eager missing worklet dependency propagates its file error", async () => {
  const dir = fixtures();
  const file = path.join(dir, "synth.uwk.ts");
  writeFileSync(file, processor('import { GAIN } from "./missing.uwk.ts";', "GAIN"));
  await expect(loadUwkProcessor(file)).rejects.toThrow(/missing\.uwk\.ts/);
  expect(readdirSync(dir)).toEqual(["synth.uwk.ts"]);
});

test("worklet dependencies in a parent directory use relative temp references", async () => {
  const dir = fixtures();
  mkdirSync(path.join(dir, "nested"));
  writeFileSync(path.join(dir, "shared.uwk.ts"), "export const GAIN = 0.5;");
  const file = path.join(dir, "nested/synth.uwk.ts");
  writeFileSync(file, processor('import { GAIN } from "../shared.uwk.ts";', "GAIN"));
  const temp = await materializeLowered(file, new Map(), new Set(), []);
  expect(readFileSync(temp, "utf8")).toMatch(/from "\.\.\/\.shared\.uwk\.ts\./);
});

test("library modules are distinguished from ambiguous processor libraries", async () => {
  const dir = fixtures();
  const library = path.join(dir, "values.uwk.ts");
  writeFileSync(library, "export const GAIN = 0.5;");
  await expect(loadUwkProcessor(library)).rejects.toBeInstanceOf(NotAProcessorError);
  const ambiguous = path.join(dir, "ambiguous.uwk.ts");
  writeFileSync(
    ambiguous,
    `export const one = defineProcessor(() => ({ process() {} }));
export const two = defineProcessor(() => ({ process() {} }));`,
  );
  await expect(loadUwkProcessor(ambiguous)).rejects.toThrow(
    /multiple defineProcessor exports.*one, two/s,
  );
  expect(readdirSync(dir).sort()).toEqual(["ambiguous.uwk.ts", "values.uwk.ts"]);
});

test("a runtime lacking type stripping gets actionable helper guidance", async () => {
  const dir = fixtures();
  const file = path.join(dir, "synth.uwk.ts");
  writeFileSync(path.join(dir, "constants.ts"), "export const GAIN: number = 0.5;");
  writeFileSync(file, processor('import { GAIN } from "./constants.ts";', "GAIN"));
  vi.spyOn(process.features, "typescript", "get").mockReturnValue(false);
  await expect(loadUwkProcessor(file)).rejects.toThrow(/cannot load TypeScript.*22\.18/s);
});

test("a real Node strip-only refusal is translated and preserves its cause", async () => {
  const dir = fixtures();
  const entry = path.join(dir, "entry.mjs");
  writeFileSync(
    entry,
    'import { stripTypeScriptTypes } from "node:module";\nstripTypeScriptTypes("enum Mode { A }");',
  );
  await expect(importLoweredEntry(entry, path.join(dir, "synth.uwk.ts"))).rejects.toMatchObject({
    message: expect.stringMatching(/synth\.uwk\.ts.*real TypeScript transform/s),
    cause: expect.objectContaining({ code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" }),
  });
});

test("a live foreign owner and a directory that resembles a temp are never swept", async () => {
  const dir = fixtures();
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const live = `.voice.u1-${owner.pid!.toString(36)}-abc123-0.uwklowered.mjs`;
    const folder = ".voice.u1-1-abc123-0.uwklowered.mjs";
    writeFileSync(path.join(dir, live), "export const GAIN = 0.5;");
    mkdirSync(path.join(dir, folder));
    const file = path.join(dir, "synth.uwk.ts");
    writeFileSync(file, processor());
    await loadUwkProcessor(file);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining([live, folder]));
  } finally {
    const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
    owner.kill();
    await exited;
  }
});

test("an unparseable owner number is preserved rather than treated as dead", async () => {
  const dir = fixtures();
  const owned = `.voice.u1-${"z".repeat(210)}-abc123-0.uwklowered.mjs`;
  writeFileSync(path.join(dir, owned), "export const GAIN = 0.5;");
  const file = path.join(dir, "synth.uwk.ts");
  writeFileSync(file, processor());
  await loadUwkProcessor(file);
  expect(readdirSync(dir)).toContain(owned);
});

test("bare package imports remain module imports while lowering a cached source", () => {
  const dir = fixtures();
  const file = path.join(dir, "synth.uwk.ts");
  const source = processor('import { f32 } from "@unworklet/core";', "f32(0.25)");
  expect(lowerUwkSource(file, source)).toContain('from "@unworklet/core"');
  expect(lowerUwkSource(file, source)).toContain("f32(0.25)");
});
