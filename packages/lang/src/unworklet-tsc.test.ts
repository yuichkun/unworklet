/**
 * `unworklet-tsc` end to end, against the *shipped* bin. The bin is the vue-tsc
 * pattern — `runTsc` driving `createUwkLanguagePlugin` — so a build type-checks
 * `.uwk.ts` sugar exactly as the editor does. This builds the real `dist` (the
 * same `vp run build` that `prepublishOnly` runs), points a throwaway project at
 * the actual `dist/unworklet-tsc.mjs`, and asserts the process result a real
 * build sees: exit 0 on valid sugar, non-zero with the type error mapped back
 * onto the `.uwk.ts` on a real mistake. Testing the dist (not an esbuild of the
 * source) is what makes this a publish-readiness check: it catches a stale or
 * mis-packed bin, which an in-memory rebuild of the source never could.
 *
 * `@unworklet/core` is resolved through a published-shape view (its built `dist`
 * `.d.mts`, which `skipLibCheck` skips) — exactly as an npm consumer would, so
 * the `.uwk.ts`'s own error surfaces rather than noise from core's `src`.
 *
 * The shipped `dist` is *copied* into the project (not symlinked): the bin reads
 * its ambient via `import.meta.dirname`, and Node resolves a symlink back to the
 * package's real `dist`, where `@unworklet/core` is the workspace `src` — a
 * different type identity than the consumer's published-view core, which would
 * manufacture spurious cross-identity errors. A copy keeps both on one core.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const LANG = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(LANG, "../..");
const CORE = path.join(REPO, "packages/core");
const VP = path.join(REPO, "node_modules/.bin/vp");

let dir: string;
let bin: string;

beforeAll(() => {
  // Build core's dist so `@unworklet/core` resolves to the shipped `.d.mts`, and
  // build lang's real dist (the publish build) so we run the actual shipped bin.
  execFileSync(VP, ["pack"], { cwd: CORE, stdio: "ignore" });
  execFileSync(VP, ["run", "build"], { cwd: LANG, stdio: "ignore" });

  // The project lives inside this package so the bin resolves `@volar/typescript`
  // / `typescript` by walking up to this package's `node_modules`.
  dir = mkdtempSync(path.join(LANG, ".uwk-tsc-"));
  // Copy (don't symlink) the shipped dist in: the bin's `import.meta.dirname`
  // must stay inside the project so its ambient's core matches the project's.
  cpSync(path.join(LANG, "dist"), path.join(dir, "dist"), { recursive: true });
  bin = path.join(dir, "dist/unworklet-tsc.mjs");

  // A published-shape `@unworklet/core`: package.json pointing at the built dist +
  // its one runtime dep (binaryen), so the `.uwk.ts` checks against core's `.d.mts`.
  const corePkg = path.join(dir, "node_modules/@unworklet/core");
  mkdirSync(corePkg, { recursive: true });
  writeFileSync(
    path.join(corePkg, "package.json"),
    JSON.stringify({
      name: "@unworklet/core",
      version: "0.0.0",
      type: "module",
      exports: { ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" } },
    }),
  );
  symlinkSync(path.join(CORE, "dist"), path.join(corePkg, "dist"));
  symlinkSync(path.join(REPO, "node_modules/binaryen"), path.join(dir, "node_modules/binaryen"));

  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        allowImportingTsExtensions: true,
        lib: ["es2023", "dom"], // a real audio app has DOM
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        // deliberately NO `plugins` — the CLI injects the language plugin itself.
      },
      include: ["check.uwk.ts"],
    }),
  );
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Run `unworklet-tsc --noEmit` over a single `.uwk.ts` source; return exit + output. */
function check(source: string): { code: number; output: string } {
  writeFileSync(path.join(dir, "check.uwk.ts"), source);
  const r = spawnSync("node", [bin, "--noEmit"], { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

test("unworklet-tsc type-checks valid .uwk.ts sugar and exits 0", () => {
  const { code, output } = check(`const input = audioInput({ channels: 2 });
const out = audioOutput({ channels: 2 });
const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });
process(() => {
  forSample((i) => {
    out.left[i] = input.left[i] * gain[i];
    out.right[i] = input.right[i] * gain[i];
  });
});`);
  expect(output).toBe("");
  expect(code).toBe(0);
});

test("unworklet-tsc passes on a real DOM + @types/node app with skipLibCheck off (the injected ambient globals must not fail the build)", () => {
  // The blind-install repro: a normal audio app loads lib.dom (global `Node`,
  // `event`) and @types/node (global `process`). The ambient declares those same
  // names as authoring globals, so they collide as `Duplicate identifier` /
  // `Cannot redeclare` in `.d.ts` space. That overlap is an artifact of injecting
  // the ambient — not an error in the user's code — so the checker must pass it
  // regardless of `skipLibCheck`. Its OWN tsconfig (separate dir) so the shared
  // one is untouched.
  const app = path.join(dir, "realapp");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    path.join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        allowImportingTsExtensions: true,
        lib: ["es2023", "dom", "dom.iterable"],
        types: ["node"], // global `process` from @types/node
        strict: true,
        noEmit: true,
        skipLibCheck: false, // the strict shop — the ambient overlap must still pass
        // deliberately NO `plugins` — the CLI injects the language plugin itself.
      },
      include: ["synth.uwk.ts"],
    }),
  );
  writeFileSync(
    path.join(app, "synth.uwk.ts"),
    `const out = audioOutput({ channels: 2 });
const gain = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" });
const env = state.f32(0).named();
const keys = event.midi({ from: "main", name: "keys" });
process(() => {
  keys.onEvent("noteOn", (e) => { env.write(f32(e.velocity)); });
  forSample((i) => {
    out.left[i] = env * gain[i];
    out.right[i] = env * gain[i];
  });
});`,
  );
  const r = spawnSync("node", [bin, "--noEmit"], { cwd: app, encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toBe("");
  expect(r.status).toBe(0);
});

test("unworklet-tsc self-seeds .unworklet/ so `extends` doesn't TS5083 on a cold checkout", () => {
  // Cold-start scenario: consumer's tsconfig extends the plugin-generated
  // `.unworklet/tsconfig.json`, but nothing has seeded it yet (no `vite dev` /
  // `vite build` run). `unworklet-tsc` must self-seed before invoking tsc.
  const cold = path.join(dir, "coldstart");
  mkdirSync(cold, { recursive: true });
  writeFileSync(
    path.join(cold, "tsconfig.json"),
    JSON.stringify({
      extends: "./.unworklet/tsconfig.json",
    }),
  );
  writeFileSync(
    path.join(cold, "check.uwk.ts"),
    `const out = audioOutput({ channels: 2 });
process(() => {
  forSample((i) => {
    out.left[i] = 0;
    out.right[i] = 0;
  });
});`,
  );
  const r = spawnSync("node", [bin, "--noEmit"], { cwd: cold, encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  // The seed step must succeed BEFORE anything else runs — TS5083 (cannot read
  // `.unworklet/tsconfig.json`) is the exact symptom of a missing seed.
  expect(output).not.toMatch(/TS5083/);
  expect(existsSync(path.join(cold, ".unworklet/tsconfig.json"))).toBe(true);
});

test("unworklet-tsc reports a .uwk.ts type error, mapped to the source, and exits non-zero", () => {
  const { code, output } = check(`const out = audioOutput({ channels: 2 });
const gate = state.bool(false).named();
process(() => {
  forSample((i) => {
    out.left[i] = gate;
  });
});`);
  expect(code).not.toBe(0);
  // a bool Node written to an f32 output — the error names both types …
  expect(output).toMatch(/Node<"bool">/);
  expect(output).toMatch(/Node<"f32">/);
  // … reported against the author's `.uwk.ts`, not a virtual file.
  expect(output).toMatch(/check\.uwk\.ts/);
});

// R4 gap 1: `preventLeadingOffset: true` had TS report the diagnostic's line/col
// against the VIRTUAL text (which prepends a multi-line ambient prologue), so
// every error landed N lines above its real position — e.g. the write on L8
// showed up as `check.uwk.ts(5,8)`. Pin the reported line/col to the author's
// actual position so a future language-plugin change cannot silently regress it.
test("unworklet-tsc reports the diagnostic on the author's line/col, not the virtual's", () => {
  const source =
    `const out = audioOutput({ channels: 1, name: "main" });\n` + // L1
    `const s = state.f32(0).named("s");\n` + // L2
    `\n` + // L3
    `process(() => {\n` + // L4
    `  forSample((i) => {\n` + // L5
    `    // Intentional type error: a string written to a Node<"f32">. Line 7.\n` + // L6
    `    out.ch(0)[i] = "not a number";\n` + // L7 — error here, col 20 = the string literal
    `  });\n` + // L8
    `});\n`; // L9
  const { code, output } = check(source);
  expect(code).not.toBe(0);
  // Column is 1-based and points at the offending argument (`"not a number"`).
  expect(output).toMatch(/check\.uwk\.ts\(7,20\)/);
});

// R5 gap 4 (D fix): cold-repo `unworklet-tsc` must populate `.unworklet/worklets.d.ts`
// itself, not fall back to the `?worklet` wildcard `CompiledProcessor<unknown>` and
// silently pass real payload / state type errors. The dogfooder hit exactly this:
// `npx unworklet-tsc --noEmit` on a cold clone printed `0 errors`, then `vite build
// && unworklet-tsc --noEmit` (order that populates the witness first) surfaced a real
// error the earlier run had hidden. Pin the fixed behavior with two paired tests —
// one that would silently pass under the old fallback (must now fail) and one that
// is genuinely valid (must still pass after populate, no false positive).
test("R5 G4: cold-repo unworklet-tsc populates the per-processor witness and catches a real payload type error the wildcard fallback would hide", () => {
  // Two-file consumer: a processor with a to-main event carrying a typed payload,
  // and a main file that reads `.on((p) => p.<name>)`. The main accesses a name
  // that is NOT in the declared payload, so a properly-populated witness turns
  // the access into a `Property 'nonexistent' does not exist` error, while the
  // pre-fix wildcard witness typed `p` as unknown and let it through.
  const app = path.join(dir, "cold-populate");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    path.join(app, "tsconfig.json"),
    // extends the plugin-seeded tsconfig — `unworklet-tsc` writes
    // `.unworklet/tsconfig.json` + an empty `worklets.d.ts` at startup, so this
    // simulates a real cold-clone consumer whose build script is
    // `"unworklet-tsc --noEmit && vite build"` (or who has not run vite build
    // yet). Nothing else populates the witness for this run.
    // Override `types` to [] because the seeded tsconfig references
    // `@unworklet/unplugin/client`, which this lang-only fixture doesn't install
    // (real consumers do install the unplugin; the assertions we care about here
    // are the per-processor witness contents, not the unplugin's ambient).
    JSON.stringify({
      extends: "./.unworklet/tsconfig.json",
      compilerOptions: { types: [] },
    }),
  );
  writeFileSync(
    path.join(app, "synth.uwk.ts"),
    `const out = audioOutput({ channels: 1, name: "main" });
const meter = event<{ peak: number }>({ to: "main", name: "meter" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0;
    meter.emitIf(bool(true), { peak: 0.5, atSample: i });
  });
});`,
  );
  writeFileSync(
    path.join(app, "main.ts"),
    `import { createNode } from "@unworklet/core";
import synth from "./synth.uwk.ts?worklet";
declare const ctx: AudioContext;
async function boot() {
  const node = await createNode(ctx, synth);
  node.events.meter.on((p) => {
    const _bad: number = p.nonexistent; // ← must fail: 'nonexistent' not in payload
    console.log(_bad);
  });
}
void boot();`,
  );
  // Simulate a cold clone: no witness populated by any prior build.
  rmSync(path.join(app, ".unworklet"), { recursive: true, force: true });
  rmSync(path.join(app, "dist"), { recursive: true, force: true });

  const r = spawnSync("node", [bin, "--noEmit"], { cwd: app, encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(r.status).not.toBe(0);
  // The offending access must be named — a generic 'has no properties' would be
  // wrong too, so pin the property name specifically.
  expect(output).toMatch(/nonexistent/);
  expect(output).toMatch(/main\.ts/);
});

test("R5 G4: cold-repo unworklet-tsc's witness populate does NOT reject a valid consumer (no false positive)", () => {
  // Same shape as the failing case, but the main-side access uses a payload
  // field that IS declared (`peak`). A populated witness must let this through —
  // otherwise the fix produces false positives that break honest consumers.
  const app = path.join(dir, "cold-valid");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    path.join(app, "tsconfig.json"),
    // extends the plugin-seeded tsconfig — `unworklet-tsc` writes
    // `.unworklet/tsconfig.json` + an empty `worklets.d.ts` at startup, so this
    // simulates a real cold-clone consumer whose build script is
    // `"unworklet-tsc --noEmit && vite build"` (or who has not run vite build
    // yet). Nothing else populates the witness for this run.
    // Override `types` to [] because the seeded tsconfig references
    // `@unworklet/unplugin/client`, which this lang-only fixture doesn't install
    // (real consumers do install the unplugin; the assertions we care about here
    // are the per-processor witness contents, not the unplugin's ambient).
    JSON.stringify({
      extends: "./.unworklet/tsconfig.json",
      compilerOptions: { types: [] },
    }),
  );
  writeFileSync(
    path.join(app, "synth.uwk.ts"),
    `const out = audioOutput({ channels: 1, name: "main" });
const meter = event<{ peak: number }>({ to: "main", name: "meter" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0;
    meter.emitIf(bool(true), { peak: 0.5, atSample: i });
  });
});`,
  );
  writeFileSync(
    path.join(app, "main.ts"),
    `import { createNode } from "@unworklet/core";
import synth from "./synth.uwk.ts?worklet";
declare const ctx: AudioContext;
async function boot() {
  const node = await createNode(ctx, synth);
  node.events.meter.on((p) => {
    const _peak: number = p.peak; // ← valid, must pass
    const _at: number = p.atSample;
    console.log(_peak, _at);
  });
}
void boot();`,
  );
  rmSync(path.join(app, ".unworklet"), { recursive: true, force: true });
  rmSync(path.join(app, "dist"), { recursive: true, force: true });

  const r = spawnSync("node", [bin, "--noEmit"], { cwd: app, encoding: "utf8" });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toBe("");
  expect(r.status).toBe(0);
});

// F-11-types: guidance-dogfood F-11 discovered that misuse of factory-handle
// primitives (a `NoiseSource` used as a `Node<"f32">` — missing `.next()`)
// passes tsc silently and only crashes at graph capture. The sugar pass's
// isDspExpr classifier does not recognise `NoiseSource` as a DSP value, so
// `n * 0.5` stays verbatim in the virtual, and stock TS catches TS2362
// (`arithmetic operation must be of type 'number' | 'bigint' | ...`).
// Pin the diagnostic surfaces so a future classify.ts refactor cannot
// silently mis-classify these factory handles as Node-like.
test("unworklet-tsc rejects `noiseSource() * 0.5` (missing .next())", () => {
  const { code, output } = check(`const out = audioOutput({ channels: 1, name: "main" });
const n = noiseSource({ seed: 42 });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = n * 0.5;
  });
});`);
  expect(code).not.toBe(0);
  // TS2362: left-hand side of arithmetic op must be number-ish.
  expect(output).toMatch(/arithmetic operation|TS2362/);
  expect(output).toMatch(/check\.uwk\.ts/);
});

// `runTsc` honours `--project`, so the witness pre-pass must resolve the same
// tsconfig. Searching from the cwd instead populated a different project (or
// none), leaving the checked one on the wildcard witness with real payload
// errors passing — the exact failure the pre-pass exists to prevent.
// Reported by @codex on #43.
test("unworklet-tsc honours --project when populating the witness", () => {
  const app = path.join(dir, "projflag");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    path.join(app, "tsconfig.json"),
    JSON.stringify({
      extends: "./.unworklet/tsconfig.json",
      compilerOptions: { types: [] },
    }),
  );
  writeFileSync(
    path.join(app, "synth.uwk.ts"),
    `const out = audioOutput({ channels: 1, name: "main" });
const meter = event<{ peak: number }>({ to: "main", name: "meter" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0;
    meter.emitIf(bool(true), { peak: 0.5, atSample: i });
  });
});`,
  );
  writeFileSync(
    path.join(app, "main.ts"),
    `import { createNode } from "@unworklet/core";
import synth from "./synth.uwk.ts?worklet";
declare const ctx: AudioContext;
async function boot() {
  const node = await createNode(ctx, synth);
  node.events.meter.on((p) => {
    const _bad: number = p.nope; // must fail once the witness is populated
    console.log(_bad);
  });
}
void boot();`,
  );
  rmSync(path.join(app, ".unworklet"), { recursive: true, force: true });

  // Run from `dir`, pointing at the subproject — the pre-pass must follow the
  // flag rather than resolving `dir`'s own tsconfig.
  const r = spawnSync("node", [bin, "--project", "projflag/tsconfig.json", "--noEmit"], {
    cwd: dir,
    encoding: "utf8",
  });
  const output = `${r.stdout}${r.stderr}`;
  expect(output).toMatch(/nope/);
  expect(existsSync(path.join(app, ".unworklet/worklets.d.ts"))).toBe(true);
});

test("the witness drops a deleted processor and keeps entries this pass does not own", () => {
  // The pre-pass owns the `.uwk.ts` entries and nothing else. Two failures live
  // here: removing the last `.uwk.ts` used to leave the old witness in place, so
  // `import x from "./deleted.uwk.ts?worklet"` kept type-checking against a
  // processor that no longer exists (an ambient pattern matches the specifier
  // text, so nothing notices the file is gone); and the pass rewrote the whole
  // file, deleting the `.processor.ts` entries only `vite build` can produce —
  // exactly the ones setup.md tells a mixed project to get by building first.
  // Reported by @codex on #43.
  const app = path.join(dir, "witness-ownership");
  mkdirSync(path.join(app, ".unworklet"), { recursive: true });
  writeFileSync(
    path.join(app, "tsconfig.json"),
    JSON.stringify({ extends: "./.unworklet/tsconfig.json", compilerOptions: { types: [] } }),
  );
  writeFileSync(
    path.join(app, "gone.uwk.ts"),
    `const out = audioOutput({ channels: 1, name: "main" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = 0;
  });
});`,
  );
  const witness = path.join(app, ".unworklet/worklets.d.ts");

  // Run once so the pass populates `gone.uwk.ts`.
  spawnSync("node", [bin, "--project", "witness-ownership/tsconfig.json", "--noEmit"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(readFileSync(witness, "utf8")).toMatch(/gone\.uwk\.ts\?worklet/);

  // Stand in for what `vite build` leaves behind for the explicit form.
  writeFileSync(
    witness,
    `${readFileSync(witness, "utf8")}
declare module "*/legacy.processor.ts?worklet" {
  const processor: import("@unworklet/core").CompiledProcessor<unknown>;
  export default processor;
}
`,
  );

  // Delete the only `.uwk.ts` and run again.
  rmSync(path.join(app, "gone.uwk.ts"));
  spawnSync("node", [bin, "--project", "witness-ownership/tsconfig.json", "--noEmit"], {
    cwd: dir,
    encoding: "utf8",
  });

  const after = readFileSync(witness, "utf8");
  expect(after).not.toMatch(/gone\.uwk\.ts\?worklet/);
  expect(after).toMatch(/legacy\.processor\.ts\?worklet/);
});
