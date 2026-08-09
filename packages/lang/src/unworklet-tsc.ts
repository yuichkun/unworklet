#!/usr/bin/env node
/**
 * `unworklet-tsc` — a `tsc`-compatible type checker that also understands the
 * `.uwk.ts` sugar. It is the vue-tsc pattern: `@volar/typescript`'s `runTsc`
 * driving the *same* Volar language plugin the editor uses
 * ({@link createUwkLanguagePlugin}), so a build agrees with the editor.
 *
 * Use it in place of `tsc` in a build script — `unworklet-tsc && vite build` — so
 * `.uwk.ts` is type-checked at build with no tsconfig `exclude`. Every `tsc` flag
 * passes through unchanged; `.ts` files are checked exactly as `tsc` would.
 *
 * On startup this also POPULATES `.unworklet/worklets.d.ts` with the real
 * per-processor `?worklet` witness for every `.uwk.ts` in the tsconfig (R5 gap 4
 * root fix): otherwise a cold checkout — `unworklet-tsc` first, `vite build`
 * second — would fall back to the wildcard `CompiledProcessor<unknown>` and
 * silently pass real payload / state / event type errors that a warm run
 * would catch.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { WorkletNamespace } from "@unworklet/core";
import { runTsc } from "@volar/typescript/lib/quickstart/runTsc.js";
import ts from "typescript";

import { createUwkLanguagePlugin } from "./ide/languagePlugin.ts";
import { isUwkSource, loadUwkProcessor } from "./materialize-lowered.ts";
import { seedUnworkletDir } from "./seed-unworklet-dir.ts";
import { workletsDts } from "./worklet-dts.ts";

// Materialize `.unworklet/tsconfig.json` (+ empty `worklets.d.ts`) in the cwd
// before tsc reads any consumer tsconfig, so a cold checkout whose tsconfig
// `"extends": "./.unworklet/tsconfig.json"` does not fail TS5083 before the
// build ever runs. Idempotent — a subsequent `vite dev` / `vite build` re-seeds
// the same file and (in the plugin's case) fills in `worklets.d.ts`.
seedUnworkletDir(process.cwd());

/**
 * Compile every `.uwk.ts` file the consumer's tsconfig would include, and
 * OVERWRITE `.unworklet/worklets.d.ts` with the aggregate `?worklet` witness.
 * This is what turns a cold `unworklet-tsc --noEmit` from "silently passes real
 * type errors because payloads fall back to `unknown`" into "sees the same
 * per-processor shapes a warm `vite build` would populate" (R5 gap 4).
 *
 * Failures on any single file (a `.uwk.ts` with syntax errors, a lowering that
 * throws, a missing sibling import) skip that entry — those show up as real tsc
 * diagnostics moments later, so we do not want the witness step to double-report
 * them. Other processors in the same project keep their populated entries.
 *
 * The `.processor.ts` (explicit form) case is NOT covered: those are ordinary
 * Node-importable TS modules and populating their witness requires a runtime
 * loader (tsx / ts-node) we do not want to pull in. Consumers who mix
 * `.processor.ts` still get the (documented) build-then-typecheck order.
 */
async function populateWorkletsWitness(cwd: string): Promise<void> {
  const tsconfigPath = ts.findConfigFile(cwd, ts.sys.fileExists.bind(ts.sys));
  if (tsconfigPath === undefined) return;
  const raw = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, "utf8"));
  if (raw.error !== undefined) return; // let tsc surface the tsconfig error itself
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(tsconfigPath));
  const uwkFiles = parsed.fileNames.filter(isUwkSource);
  if (uwkFiles.length === 0) return;

  const entries: { source: string; ns: WorkletNamespace }[] = [];
  for (const file of uwkFiles) {
    try {
      const processor = await loadUwkProcessor(file);
      entries.push({ source: file, ns: processor.worklet });
    } catch {
      // A lowering / compile / import failure here is a real user-facing error
      // that tsc will surface a moment later — skip populate for this file
      // (leaves it on the wildcard fallback for this run).
    }
  }
  if (entries.length === 0) return;

  const witnessDir = path.join(cwd, ".unworklet");
  fs.mkdirSync(witnessDir, { recursive: true });
  const witnessPath = path.join(witnessDir, "worklets.d.ts");
  fs.writeFileSync(witnessPath, workletsDts(entries));
}

await populateWorkletsWitness(process.cwd());

const tscPath = createRequire(import.meta.url).resolve("typescript/lib/tsc");
// The shipped ambient (`audioInput` / `state` / `mul` / … as globals) sits next to
// this bin in `dist/`. A `.uwk.ts` writes no imports, so the lowered sugar needs it.
const ambient = path.join(import.meta.dirname, "ambient.d.ts");

/** `options` here is the very object `runTsc` builds the program from, so the
 * callback is the place to augment its root files — but `rootNames` is typed
 * `readonly`. Strip that to inject the ambient. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

runTsc(tscPath, [".uwk.ts"], (ts, options) => {
  // Inject the ambient into the program's root files — the CLI counterpart of the
  // editor plugin's host `getScriptFileNames` decoration.
  if (!options.rootNames.includes(ambient)) {
    (options as Mutable<typeof options>).rootNames = [...options.rootNames, ambient];
  }
  // The ambient declares the authoring globals (`Node` / `event` / `process`) that
  // intentionally shadow the same-named `lib.dom` / `@types/node` globals — a `.uwk.ts`
  // writes no imports, so they must be global. That overlap is an artifact of
  // injecting the ambient, not a mistake in the user's code, so it must not fail
  // the build: under `skipLibCheck: false` it otherwise surfaces as `Duplicate
  // identifier 'Node'` / `Cannot redeclare 'event'` pointing into `lib.dom.d.ts`.
  // Skipping `.d.ts` checks scopes this checker to its job — the sugar. Your
  // `.uwk.ts` / `.ts` are still fully checked; auditing `lib` / `@types` conflicts
  // is your own `tsc`'s job, which never injects this ambient and so never sees it.
  options.options.skipLibCheck = true;
  return { languagePlugins: [createUwkLanguagePlugin(ts)] };
});
