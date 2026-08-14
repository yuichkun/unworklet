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

import { loadUwkProcessor, lowerUwkSource, materializeLowered } from "./materialize-lowered.ts";

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

test("a reserved-word filename still yields a loadable module", async () => {
  // `class.uwk.ts` derived the export name `class`, so the temp read
  // `export const class = defineProcessor(...)` — a syntax error, and neither
  // loader could import it. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-reserved-"));
  const src = path.join(dir, "class.uwk.ts");
  writeFileSync(
    src,
    `const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0.25;
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});

test("a plain .mts / .cts helper import is caught by the same guard as .ts", () => {
  // Node strips `.ts`, `.mts` and `.cts` alike once it can strip at all, so all
  // three are unloadable when it cannot — checking only `.ts` let `.mts` through
  // to the cryptic failure. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-mts-"));
  writeFileSync(path.join(dir, "constants.mts"), `export const GAIN: number = 3;\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./constants.mts";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN * 0.1;
  });
});`,
  );

  const script = `
    delete process.features.typescript;
    const { materializeLowered } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    try {
      await materializeLowered(${JSON.stringify(src)}, new Map(), new Set(), []);
      console.log("NO_THROW");
    } catch (e) { console.log("THREW:" + e.message); }
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toMatch(/THREW:/);
  expect(output).toMatch(/constants\.mts/);
});

test("a subgraph library re-exported through a barrel .uwk.ts still lowers", async () => {
  // Dependency discovery walked import declarations only, so a barrel's
  // `export { x } from "./x.uwk.ts"` was neither lowered nor rewritten: the temp
  // kept pointing at the raw `.uwk.ts`, whose bare DSL globals only exist after
  // lowering. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-barrel-"));
  writeFileSync(
    path.join(dir, "onepole.uwk.ts"),
    `export const onepole = defineSubgraph(() => {
  const z = state.f32(0).named("z");
  return {
    tick: (x: Node<"f32">) => {
      z.write(z + (x - z) * 0.05);
      return z;
    },
  };
});`,
  );
  writeFileSync(path.join(dir, "lib.uwk.ts"), `export { onepole } from "./onepole.uwk.ts";\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { onepole } from "./lib.uwk.ts";

const out = audioOutput({ channels: 1, name: "main" });
const lp = instantiate(onepole, { name: "lp" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = lp.tick(f32(0.5));
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});

test("an inline type-only import is not mistaken for a runtime .ts dependency", () => {
  // `import { type Gain } from "./types.ts"` sets `isTypeOnly` on the SPECIFIER,
  // not on the import clause — only `import type { Gain } ...` sets the clause.
  // The transpile erases both alike, so Node never loads the file and the
  // capability guard must not reject it. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-inlineType-"));
  writeFileSync(path.join(dir, "types.ts"), `export type Gain = number;\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { type Gain } from "./types.ts";
const g: Gain = 0.25;
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = g;
  });
});`,
  );

  const script = `
    delete process.features.typescript;
    const { materializeLowered } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    const temp = await materializeLowered(${JSON.stringify(src)}, new Map(), new Set(), []);
    await import(temp);
    console.log("LOADED");
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toMatch(/LOADED/);
});

test("a helper needing a real TypeScript transform is reported, not left as ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", () => {
  // The capability guard only asks whether this Node can load TypeScript at all.
  // Node 22.18+ says yes — but only for ERASABLE TypeScript: an `enum` (or a
  // `namespace`, or a parameter property) needs a real transform, which lives
  // behind `--experimental-transform-types`. So the guard's advertised "upgrade
  // Node" way out can still end in a Node-level syntax error the consumer has no
  // reason to connect with this toolchain. Reported by @codex on #43.
  //
  // Runs in a child process for the same reason the Node-20 cases above do: the
  // `import()` has to be Node's. In-process it would be Vite's module runner,
  // which transforms an enum happily and never reaches the failure.
  dir = mkdtempSync(path.join(LANG, ".mat-enum-"));
  writeFileSync(path.join(dir, "helper.ts"), `export enum Mode { A, B }\nexport const GAIN = 3;\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./helper.ts";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN * 0.1;
  });
});`,
  );

  const script = `
    const { loadUwkProcessor } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    try {
      await loadUwkProcessor(${JSON.stringify(src)});
      console.log("NO_THROW");
    } catch (e) {
      console.log("MSG:" + e.message);
      console.log("CAUSE:" + e.cause?.code);
    }
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toMatch(/MSG:@unworklet\/lang/);
  expect(output).toMatch(/experimental-transform-types/);
  expect(output).toMatch(/\.mjs/);
  // The original stays reachable — its stack is what names the offending file.
  expect(output).toMatch(/CAUSE:ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);

  // And the failure still cleans up after itself.
  expect(readdirSync(dir).filter((f) => f.includes("uwklowered"))).toEqual([]);
});

test("a .uwk.ts reached through a plain .ts helper is reported, not loaded raw", async () => {
  // A plain `.ts` barrel re-exporting a subgraph library (`export { voice } from
  // "./voice.uwk.ts"`) is invisible to lowering: the helper is the author's own
  // module, so nothing rewrites its specifier, and Node loads `voice.uwk.ts` raw
  // — bare authoring globals and all. `ReferenceError: defineSubgraph is not
  // defined` gives no hint of the cause. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-tsbarrel-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const phase = state.f32(0).named("phase");
  return { tick: () => phase };
});`,
  );
  writeFileSync(path.join(dir, "barrel.ts"), `export { voice } from "./voice.uwk.ts";\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./barrel.ts";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick();
  });
});`,
  );

  const err = await loadUwkProcessor(src).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err?.message).toMatch(/@unworklet\/lang/);
  // Names both ends of the chain, so the fix is obvious from the message alone.
  expect(err?.message).toMatch(/barrel\.ts/);
  expect(err?.message).toMatch(/voice\.uwk\.ts/);
  expect(err?.message).not.toMatch(/defineSubgraph is not defined/);

  expect(readdirSync(dir).filter((f) => f.includes("uwklowered"))).toEqual([]);
});

test("a helper's type-only re-export of a .uwk.ts is not treated as a runtime edge", async () => {
  // Node's strip-only mode erases `export type { X } from "./y.uwk.ts"` entirely
  // — the module is never loaded — so a helper carrying one is perfectly
  // loadable and must not be rejected by the diagnostic above. (Its INLINE
  // cousin, `export { type X } from …`, is a different case: Node drops the
  // specifier but keeps the module edge, so that one is still a live edge.)
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-typeonly-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export type VoiceHandle = { tick: () => Node<"f32"> };
export const voice = defineSubgraph(() => {
  const phase = state.f32(0).named("phase");
  return { tick: () => phase };
});`,
  );
  writeFileSync(
    path.join(dir, "helper.ts"),
    `export type { VoiceHandle } from "./voice.uwk.ts";\nexport const GAIN = 0.25;\n`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./helper.ts";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN;
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});

test("editing a sibling subgraph re-lowers its importer, whose own text did not change", async () => {
  // `lower()` is type-directed: whether a bare state passed to a subgraph method
  // gets an auto-inserted `.read()` depends on that method's declared parameter
  // type, which lives in the SIBLING file. Keying the lowering cache on the
  // importer's own path and text alone therefore serves a stale lowering to the
  // dev server's rebuild after a subgraph-only edit. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-sibling-"));
  const voice = path.join(dir, "voice.uwk.ts");
  const synth = path.join(dir, "synth.uwk.ts");
  const synthText = `import { voice } from "./voice.uwk.ts";

const gain = state.f32(0.5).named("gain");
const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick(gain);
  });
});`;
  writeFileSync(synth, synthText);

  // A `State<"f32">` parameter takes the state itself — the bare `gain` stays a
  // reference.
  writeFileSync(
    voice,
    `export const voice = defineSubgraph(() => ({
  tick: (s: State<"f32">) => s.read() * f32(2),
}));`,
  );
  const withState = lowerUwkSource(synth, synthText);

  // A `Node<"f32">` parameter takes a value — the same bare `gain` must now be
  // read.
  writeFileSync(
    voice,
    `export const voice = defineSubgraph(() => ({
  tick: (x: Node<"f32">) => mul(x, f32(2)),
}));`,
  );
  const withNode = lowerUwkSource(synth, synthText);

  expect(withNode).not.toBe(withState);
});

test("the lowering cache follows a dependency written with a .js specifier", () => {
  // NodeNext substitutes extensions: `import type { TickArg } from "./types.js"`
  // resolves to `types.ts`. Deciding the dependency set by the specifier's
  // literal extension therefore misses a file whose types the lowering very much
  // reads — and a stale key is invisible, because the importer's own text and
  // its sibling's are both unchanged. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-jsspec-"));
  const types = path.join(dir, "types.ts");
  const synth = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `import type { TickArg } from "./types.js";
export const voice = defineSubgraph(() => ({ tick: (s: TickArg) => f32(1) }));`,
  );
  const synthText = `import { voice } from "./voice.uwk.ts";

const gain = state.f32(0.5).named("gain");
const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick(gain);
  });
});`;
  writeFileSync(synth, synthText);

  writeFileSync(types, `export type TickArg = State<"f32">;\n`);
  const withState = lowerUwkSource(synth, synthText);

  writeFileSync(types, `export type TickArg = Node<"f32">;\n`);
  const withNode = lowerUwkSource(synth, synthText);

  expect(withState).toMatch(/tick\(gain\)/);
  expect(withNode).toMatch(/tick\(gain\.read\(\)\)/);
});

test("a .uwk.ts reached through a JavaScript helper is reported too", async () => {
  // The diagnostic for the TypeScript case recommends renaming the helper to
  // `.mjs` — an extension the check itself did not walk, so the recommended way
  // out led straight back to `defineSubgraph is not defined`.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-jsbarrel-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const phase = state.f32(0).named("phase");
  return { tick: () => phase };
});`,
  );
  writeFileSync(path.join(dir, "barrel.mjs"), `export { voice } from "./voice.uwk.ts";\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./barrel.mjs";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick();
  });
});`,
  );

  const err = await loadUwkProcessor(src).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err?.message).toMatch(/@unworklet\/lang/);
  expect(err?.message).toMatch(/barrel\.mjs/);
  expect(err?.message).toMatch(/voice\.uwk\.ts/);
  expect(err?.message).not.toMatch(/defineSubgraph is not defined/);
});

test("editing a helper between two loads in one process recompiles against the new value", () => {
  // Node's ESM cache is permanent and keyed by URL. The entry temp is
  // cache-busted, but its `./constants.mjs` specifier resolved to the same URL
  // both times, so the second load silently compiled the FIRST run's constant
  // into the graph — a wrong result with nothing to indicate it.
  // Runs in a child process because in-process the `import()` would be Vite's
  // module runner, which has its own invalidation and never shows this.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-helperCache-"));
  const constants = path.join(dir, "constants.mjs");
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./constants.mjs";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN;
  });
});`,
  );

  const script = `
    const { writeFileSync } = await import("node:fs");
    const { loadUwkProcessor } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    writeFileSync(${JSON.stringify(constants)}, "export const GAIN = 0.25;\\n");
    const a = await loadUwkProcessor(${JSON.stringify(src)});
    writeFileSync(${JSON.stringify(constants)}, "export const GAIN = 0.75;\\n");
    const b = await loadUwkProcessor(${JSON.stringify(src)});
    const j = (p) => JSON.stringify(p.graph);
    console.log("FIRST_HAS_025:" + j(a).includes("0.25"));
    console.log("SECOND_HAS_075:" + j(b).includes("0.75"));
    console.log("SECOND_HAS_025:" + j(b).includes("0.25"));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toMatch(/FIRST_HAS_025:true/);
  expect(output).toMatch(/SECOND_HAS_075:true/);
  expect(output).toMatch(/SECOND_HAS_025:false/);
});

test("a query on a helper's specifier does not hide the .uwk.ts behind it", async () => {
  // `export { voice } from "./voice.uwk.ts?rev=1"` is a legal ESM specifier —
  // Node accepts a query on a file URL. The walk classified specifiers by their
  // raw text, so neither the `.uwk.ts` test nor the extension test matched and
  // the traversal stopped one edge short of what it exists to find.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-query-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  return { tick: () => p };
});`,
  );
  writeFileSync(path.join(dir, "barrel.mjs"), `export { voice } from "./voice.uwk.ts?rev=1";\n`);
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./barrel.mjs";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick();
  });
});`,
  );

  const err = await loadUwkProcessor(src).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err?.message).toMatch(/@unworklet\/lang/);
  expect(err?.message).toMatch(/voice\.uwk\.ts/);
  expect(err?.message).not.toMatch(/defineSubgraph is not defined/);
});

test("a second-level helper edited mid-process is reported, never compiled stale", () => {
  // Only helpers the temp imports directly can have their module URL keyed on
  // content — a helper reached THROUGH another one is resolved by a specifier in
  // a module this package does not own. Re-evaluating the outer helper does not
  // help: Node resolves its `./b.mjs` to the same URL and hands back the cached
  // module (verified — the outer one re-runs and still sees the old value).
  //
  // So the answer is not to compile it stale and stay quiet. The load fails and
  // names the file. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-deepHelper-"));
  const b = path.join(dir, "b.mjs");
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(path.join(dir, "a.mjs"), `export { GAIN } from "./b.mjs";\n`);
  writeFileSync(
    src,
    `import { GAIN } from "./a.mjs";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN;
  });
});`,
  );

  const script = `
    const { writeFileSync } = await import("node:fs");
    const { loadUwkProcessor } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    writeFileSync(${JSON.stringify(b)}, "export const GAIN = 0.25;\\n");
    const first = await loadUwkProcessor(${JSON.stringify(src)});
    console.log("FIRST_HAS_025:" + JSON.stringify(first.graph).includes("0.25"));
    writeFileSync(${JSON.stringify(b)}, "export const GAIN = 0.75;\\n");
    try {
      const second = await loadUwkProcessor(${JSON.stringify(src)});
      console.log("SECOND_STALE:" + JSON.stringify(second.graph).includes("0.25"));
    } catch (e) {
      console.log("THREW:" + e.message);
    }
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toMatch(/FIRST_HAS_025:true/);
  expect(output).not.toMatch(/SECOND_STALE:true/);
  expect(output).toMatch(/THREW:@unworklet\/lang/);
  expect(output).toMatch(/b\.mjs/);
  // And it says what to do about it.
  expect(output).toMatch(/restart/i);
});

test("an unchanged second-level helper does not trip the staleness check", () => {
  // The check must only fire on an actual change: loading the same processor
  // twice with nothing edited is ordinary, and failing there would make the
  // guard worse than the bug. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-deepHelperOk-"));
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(path.join(dir, "b.mjs"), `export const GAIN = 0.25;\n`);
  writeFileSync(path.join(dir, "a.mjs"), `export { GAIN } from "./b.mjs";\n`);
  writeFileSync(
    src,
    `import { GAIN } from "./a.mjs";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN;
  });
});`,
  );

  const script = `
    const { loadUwkProcessor } = await import(${JSON.stringify(pathToFileURL(path.join(LANG, "dist/index.mjs")).href)});
    await loadUwkProcessor(${JSON.stringify(src)});
    await loadUwkProcessor(${JSON.stringify(src)});
    console.log("BOTH_OK");
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  expect(`${r.stdout}${r.stderr}`).toMatch(/BOTH_OK/);
});

test("a type reached through an import-type expression is part of the lowering cache key", () => {
  // `(s: import("./types.ts").TickArg)` names a module without an import
  // declaration, so a scan of top-level statements never saw it — yet it decides
  // whether the caller's bare state gets an auto-read. Verified both ways: the
  // lowering does change with `types.ts`, and the cache was serving the old one.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-importType-"));
  const types = path.join(dir, "types.ts");
  const synth = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => ({
  tick: (s: import("./types.ts").TickArg) => f32(1),
}));`,
  );
  const synthText = `import { voice } from "./voice.uwk.ts";

const gain = state.f32(0.5).named("gain");
const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick(gain);
  });
});`;
  writeFileSync(synth, synthText);

  writeFileSync(types, `export type TickArg = State<"f32">;\n`);
  expect(lowerUwkSource(synth, synthText)).toMatch(/tick\(gain\)/);

  writeFileSync(types, `export type TickArg = Node<"f32">;\n`);
  expect(lowerUwkSource(synth, synthText)).toMatch(/tick\(gain\.read\(\)\)/);
});

test("a .uwk.ts a helper imports dynamically is reported like a static one", async () => {
  // `await import("./voice.uwk.ts")` is a real runtime edge, and scanning only
  // top-level declarations missed it — so the raw sugar reached Node and failed
  // on its authoring globals, the same ending the static case now diagnoses.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-dynimport-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  return { tick: () => p };
});`,
  );
  writeFileSync(
    path.join(dir, "helper.mjs"),
    `export const load = () => import("./voice.uwk.ts");\nexport const GAIN = 0.5;\n`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./helper.mjs";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN;
  });
});`,
  );

  const err = await loadUwkProcessor(src).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err?.message).toMatch(/@unworklet\/lang/);
  expect(err?.message).toMatch(/voice\.uwk\.ts/);
});

test("a template-literal dynamic import is a module reference like any other", async () => {
  // `import(`./voice.uwk.ts`)` is a NoSubstitutionTemplateLiteral, not a
  // StringLiteral — just as static as the quoted form, and skipped by the walk,
  // so the helper loaded raw sugar instead of producing the diagnostic.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-tmplImport-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  return { tick: () => p };
});`,
  );
  writeFileSync(
    path.join(dir, "helper.mjs"),
    "export const load = () => import(`./voice.uwk.ts`);\nexport const GAIN = 0.5;\n",
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./helper.mjs";
const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN;
  });
});`,
  );

  const err = await loadUwkProcessor(src).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err?.message).toMatch(/@unworklet\/lang/);
  expect(err?.message).toMatch(/voice\.uwk\.ts/);
});

test("a sibling .uwk.ts imported with a query is lowered, not loaded raw", async () => {
  // The `.uwk.ts` selector tested the raw specifier while every other classifier
  // had moved to the file part, so `"./voice.uwk.ts?rev=1"` was skipped by
  // materialization and Node loaded the unlowered source — `defineSubgraph is
  // not defined`. (TypeScript cannot resolve a query-bearing specifier either,
  // so this form gets no types; that is tsc's to report, and is no reason to
  // hand Node raw sugar.) Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-uwkQuery-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const GAIN = 0.25;
export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  return { tick: () => p };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { GAIN } from "./voice.uwk.ts?rev=1";

const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = GAIN;
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});

test("concurrent loads sharing a sibling do not delete each other's temps", async () => {
  // Two entries importing the same subgraph produced the same content-derived
  // temp path, and each load's cleanup removed it — so whichever finished first
  // could unlink a file the other had not imported yet, giving an intermittent
  // ERR_MODULE_NOT_FOUND for an ordinary `Promise.all`. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-concurrent-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  return { tick: () => p };
});`,
  );
  const entry = (name: string, level: string): string => {
    const file = path.join(dir, name);
    writeFileSync(
      file,
      `import { voice } from "./voice.uwk.ts";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick() * ${level};
  });
});`,
    );
    return file;
  };
  const a = entry("a.uwk.ts", "0.25");
  const b = entry("b.uwk.ts", "0.75");

  // The shared sibling must land on a DIFFERENT path per load, so one load's
  // cleanup can never touch the other's — the property the race turns on,
  // asserted directly rather than by trying to lose a timing window.
  const cleanupA: string[] = [];
  const cleanupB: string[] = [];
  cleanup.push(...cleanupA, ...cleanupB);
  await Promise.all([
    materializeLowered(a, new Map(), new Set(), cleanupA),
    materializeLowered(b, new Map(), new Set(), cleanupB),
  ]);
  const sibling = (list: string[]): string =>
    list.find((p) => path.basename(p).startsWith(".voice.uwk.ts"))!;
  expect(sibling(cleanupA)).toBeDefined();
  expect(sibling(cleanupA)).not.toBe(sibling(cleanupB));
  for (const p of [...cleanupA, ...cleanupB]) cleanup.push(p);

  const [pa, pb] = await Promise.all([loadUwkProcessor(a), loadUwkProcessor(b)]);
  expect(typeof pa.schemaHash).toBe("string");
  expect(typeof pb.schemaHash).toBe("string");
});

test("a type-only reference between two .uwk.ts files is not a cycle", async () => {
  // Discovery fed every module reference to materialization, including the ones
  // TypeScript erases. A sibling naming its importer back in a type position is
  // then walked as a real dependency, meets the entry mid-materialization, and
  // the load is rejected as cyclic — while the module graph Node actually sees
  // has no cycle at all. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-typecycle-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `import type { Depth } from "./synth.uwk.ts";

export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  const _depth: Depth = "shallow";
  return { tick: () => p.read() };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./voice.uwk.ts";

export type Depth = "shallow" | "deep";
const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick();
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});

test("an import-type expression naming a .uwk.ts is not a cycle either", async () => {
  // Same erasure, written as `import("./synth.uwk.ts").Depth` — the form that
  // needs no import declaration at all. Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-typecycle2-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  const _depth: import("./synth.uwk.ts").Depth = "shallow";
  return { tick: () => p.read() };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./voice.uwk.ts";

export type Depth = "shallow" | "deep";
const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick();
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});

test("an all-type-only inline import between two .uwk.ts files is not a cycle", async () => {
  // `import { type Depth } from …` marks the SPECIFIER rather than the clause,
  // so a clause-level test still walked it as a dependency and reported a cycle.
  // The emit is unambiguous here: with every named specifier type-only there is
  // nothing left to import, and the statement goes. (A MIXED declaration is a
  // different case — its value binding may well survive — and is still walked.)
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-inlinecycle-"));
  writeFileSync(
    path.join(dir, "voice.uwk.ts"),
    `import { type Depth } from "./synth.uwk.ts";

export const voice = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  const _depth: Depth = "shallow";
  return { tick: () => p.read() };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { voice } from "./voice.uwk.ts";

export type Depth = "shallow" | "deep";
const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(voice, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick();
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});

test("an unused import of a sibling is not walked as a dependency", async () => {
  // The emit drops an import whose bindings go unused, whatever shape the
  // declaration has — so classifying by shape reports an edge Node never sees.
  // Here `a`'s only edge to `b` is an unused default import while `b` imports
  // `a` for real: the emitted graph is a single edge, and walking the erased one
  // met `b` mid-materialization and rejected the load as cyclic.
  // Reported by @codex on #43.
  dir = mkdtempSync(path.join(LANG, ".mat-unusedimport-"));
  writeFileSync(
    path.join(dir, "a.uwk.ts"),
    `import Unused from "./b.uwk.ts";

export const GAIN = 0.5;`,
  );
  writeFileSync(
    path.join(dir, "b.uwk.ts"),
    `import { GAIN } from "./a.uwk.ts";

export const b = defineSubgraph(() => {
  const p = state.f32(0).named("p");
  return { tick: () => p.read() * f32(GAIN) };
});`,
  );
  const src = path.join(dir, "synth.uwk.ts");
  writeFileSync(
    src,
    `import { b } from "./b.uwk.ts";

const out = audioOutput({ channels: 1, name: "main" });
const v = instantiate(b, { name: "v" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = v.tick();
  });
});`,
  );

  const proc = await loadUwkProcessor(src);
  expect(typeof proc.schemaHash).toBe("string");
});
