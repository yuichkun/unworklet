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
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
