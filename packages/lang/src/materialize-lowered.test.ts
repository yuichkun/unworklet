/**
 * `materializeLowered` writes the temp modules that `loadUwkProcessor` (and the
 * Vite plugin's dev path) hand to a dynamic `import()`. Those temps must be
 * loadable by plain Node across the range `packages/lang/package.json` declares
 * it supports — `"node": ">=20"`.
 *
 * That is not a given: the lowered output is TypeScript, and Node only learned to
 * strip types natively in 22.18 / 23.6. On Node 20 an `import()` of a `.ts` file
 * throws `ERR_UNKNOWN_FILE_EXTENSION` before the processor is ever evaluated.
 * Nothing in CI catches it — every job pins Node 24 — so the regression is
 * pinned here instead, by running the produced temp in a child process with
 * native stripping switched off. That is precisely what Node 20 offers: no
 * stripping at all.
 *
 * Reported by @codex on #43.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test } from "vite-plus/test";

import { loadUwkProcessor, materializeLowered } from "./materialize-lowered.ts";

// The fixtures live inside this package so the lowered temps resolve
// `@unworklet/core` by walking up to `packages/lang/node_modules`, exactly as a
// consumer's temps resolve it from their own project.
const LANG = path.resolve(import.meta.dirname, "..");

let dir: string;
const cleanup: string[] = [];

afterEach(() => {
  for (const f of cleanup.splice(0)) rmSync(f, { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Import `temp` in a child Node with native type-stripping disabled. */
function importWithoutTypeStripping(temp: string): { code: number; output: string } {
  const r = spawnSync(
    "node",
    [
      "--no-experimental-strip-types",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(temp).href)});`,
    ],
    { encoding: "utf8" },
  );
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

test("a single-file processor's temp loads on a Node without native type-stripping (= Node 20)", async () => {
  dir = mkdtempSync(path.join(LANG, ".mat-single-"));
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0.5;
  });
});`,
  );

  const temp = await materializeLowered(src, new Map(), new Set(), cleanup);
  const { code, output } = importWithoutTypeStripping(temp);
  expect(output).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION/);
  expect(code, output).toBe(0);
});

test("a processor importing a sibling subgraph loads without native type-stripping — the rewritten specifiers point at loadable temps too", async () => {
  dir = mkdtempSync(path.join(LANG, ".mat-multi-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const phase = state.f32(0).named("phase");
  return {
    tick: (hz: Node<"f32">) => {
      phase.write((phase + hz / 48000) % 1);
      return phase;
    },
  };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./voice.uwk.ts";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick(f32(220));
  });
});`,
  );

  const temp = await materializeLowered(src, new Map(), new Set(), cleanup);
  const { code, output } = importWithoutTypeStripping(temp);
  expect(output).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION/);
  expect(code, output).toBe(0);
});

test("loadUwkProcessor accepts the documented relative path", async () => {
  // The published example is `loadUwkProcessor("./my-synth.uwk.ts")`. A relative
  // input broke twice: the lowering's program could not find the input, and the
  // temp path `path.join(".", ".x.uwklowered.mjs")` has no `./` prefix, so
  // `import()` would read it as a bare specifier. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-rel-"));
  writeFileSync(
    path.join(dir, "synth.uwk.ts"),
    `const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0.5;
  });
});`,
  );

  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const proc = await loadUwkProcessor("./synth.uwk.ts");
    expect(typeof proc.schemaHash).toBe("string");
  } finally {
    process.chdir(prevCwd);
  }
});

test("a plain .ts helper import fails loudly on a Node that cannot strip types, instead of ERR_UNKNOWN_FILE_EXTENSION at import", () => {
  // Lowering leaves an author's `./constants.ts` specifier alone, so the temp
  // still imports raw TypeScript. Transpiling the author's own modules would mean
  // guessing their tsconfig and possibly changing their code's meaning, so this
  // reports the situation instead. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-plainTs-"));
  writeFileSync(path.join(dir, "constants.ts"), `export const GAIN: number = 3;\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./constants.ts";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN * 0.1;
  });
});`,
  );

  // Node 20 does not merely disable the capability — `process.features.typescript`
  // is ABSENT there, so it reads `undefined`, not `false`. Both shapes are covered:
  // deleting the property (what Node 20 actually looks like) and a modern Node with
  // stripping switched off. Testing only the latter is what let a `=== false` check
  // pass while missing the runtime it was written for.
  const body = `
    const { materializeLowered } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    try {
      await materializeLowered(${JSON.stringify(src)}, new Map(), new Set(), []);
      console.log("NO_THROW");
    } catch (e) { console.log("THREW:" + e.message); }
  `;
  const cases: [string, string[]][] = [
    [
      "absent (Node 20)",
      ["--input-type=module", "-e", `delete process.features.typescript;${body}`],
    ],
    ["disabled", ["--no-experimental-strip-types", "--input-type=module", "-e", body]],
  ];
  for (const [label, args] of cases) {
    const r = spawnSync("node", args, { encoding: "utf8" });
    const output = `${r.stdout}${r.stderr}`;
    expect(output, label).toMatch(/THREW:/);
    expect(output, label).toMatch(/constants\.ts/);
    expect(output, label).toMatch(/22\.18/);
  }
});

test("a failed materialization leaves no temp behind in the source tree", async () => {
  // Siblings are written as the recursion descends, so a failure after one lands
  // (here: the sibling lowers, then the entry's plain-.ts import is rejected)
  // used to strand `.uwklowered.mjs` files next to the consumer's sources.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-leak-"));
  writeFileSync(path.join(dir, "constants.ts"), `export const GAIN: number = 3;\n`);
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const phase = state.f32(0).named("phase");
  return { tick: () => phase };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./voice.uwk.ts";
import { GAIN } from "./constants.ts";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick() * GAIN;
  });
});`,
  );

  const script = `
    delete process.features.typescript;
    const { loadUwkProcessor } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    try { await loadUwkProcessor(${JSON.stringify(src)}); } catch { /* expected */ }
  `;
  spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });

  const strays = readdirSync(dir).filter((f) => f.includes("uwklowered"));
  expect(strays, `stray temps: ${strays.join(", ")}`).toEqual([]);
});
