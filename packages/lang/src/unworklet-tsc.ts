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
import { isUwkSource, loadUwkProcessor, NotAProcessorError } from "./materialize-lowered.ts";
import { seedUnworkletDir } from "./seed-unworklet-dir.ts";
import { workletsDts } from "./worklet-dts.ts";

/**
 * The directory whose `.unworklet/` this run owns. Both the seed and the witness
 * belong next to the tsconfig being checked, not next to the cwd: the generated
 * `.unworklet/tsconfig.json` is reached by the consumer's
 * `"extends": "./.unworklet/tsconfig.json"`, which resolves relative to that
 * tsconfig. With `--project sub/tsconfig.json` run from the repo root, seeding
 * the root would leave `sub/` unseeded and its witness empty.
 */
const projectConfig = resolveProjectConfig(process.cwd(), process.argv.slice(2));
const projectDir = projectConfig === undefined ? process.cwd() : path.dirname(projectConfig);

// Materialize `.unworklet/tsconfig.json` (+ empty `worklets.d.ts`) before tsc
// reads any consumer tsconfig, so a cold checkout whose tsconfig
// `"extends": "./.unworklet/tsconfig.json"` does not fail TS5083 before the
// build ever runs. Idempotent — a subsequent `vite dev` / `vite build` re-seeds
// the same file and (in the plugin's case) fills in `worklets.d.ts`.
seedUnworkletDir(projectDir);

/**
 * The tsconfig this invocation is actually about. `runTsc` honours `--project`
 * / `-p`, so a pre-pass that always searched from the cwd would populate (or
 * skip) a different project than the one being checked — leaving the checked
 * project on the wildcard witness with real payload / state errors passing,
 * which is the failure this pre-pass exists to prevent. A directory argument
 * means "the tsconfig.json inside it", matching tsc.
 */
function resolveProjectConfig(cwd: string, argv: readonly string[]): string | undefined {
  const i = argv.findIndex((a) => a === "--project" || a === "-p");
  const explicit = i >= 0 ? argv[i + 1] : undefined;
  if (explicit === undefined) return ts.findConfigFile(cwd, ts.sys.fileExists.bind(ts.sys));
  const resolved = path.resolve(cwd, explicit);
  if (ts.sys.directoryExists(resolved)) {
    const inDir = path.join(resolved, "tsconfig.json");
    return ts.sys.fileExists(inDir) ? inDir : undefined;
  }
  return ts.sys.fileExists(resolved) ? resolved : undefined;
}

/**
 * The `declare module` blocks of an existing witness that did NOT come from a
 * `.uwk.ts` — i.e. the `.processor.ts` entries only `vite build` can produce.
 *
 * Splitting the generated file textually is enough because it is generated:
 * `workletDts` writes each block starting at column 0 and closing with a `}` at
 * column 0, so a block boundary is unambiguous. A hand-edit would not survive,
 * which is correct for a file the toolchain owns and `.gitignore`s.
 */
function foreignWitnessBlocks(witness: string): string {
  return witness
    .split(/^(?=declare module )/m)
    .filter(
      (block) => block.trim() !== "" && !/^declare module "[^"]*\.uwk\.ts\?worklet"/.test(block),
    )
    .join("");
}

/**
 * Compile every `.uwk.ts` the given tsconfig includes and rewrite the `.uwk.ts`
 * half of its `.unworklet/worklets.d.ts`. This is what turns a cold
 * `unworklet-tsc --noEmit` from "silently passes real type errors because
 * payloads fall back to `unknown`" into "sees the same per-processor shapes a
 * warm `vite build` would populate".
 *
 * This pass owns exactly the `.uwk.ts` entries, and rewrites them to the set it
 * could load — so deleting or renaming a processor removes its entry rather than
 * leaving a witness for a file that is gone (an ambient pattern matches the
 * specifier text, so nothing else would notice).
 *
 * A processor that cannot be loaded is REPORTED and fails the run. Not every such
 * failure is something tsc goes on to report: `noiseSource({ seed: 0.5 })`
 * satisfies TypeScript's `number` and throws when the graph is captured, so
 * swallowing it let the command exit 0 on a processor that cannot be compiled —
 * and left every consumer of it on the wildcard witness, which is the silent pass
 * this pre-pass exists to prevent. tsc still runs first, so its own diagnostics
 * (usually the more precise account) are not displaced by ours.
 *
 * The `.processor.ts` (explicit form) case is NOT covered: those are ordinary
 * Node-importable TS modules and populating their witness requires a runtime
 * loader (tsx / ts-node) we do not want to pull in. Consumers who mix
 * `.processor.ts` still get the (documented) build-then-typecheck order — which
 * is why those blocks are carried across rather than overwritten.
 */
async function populateWorkletsWitness(tsconfigPath: string | undefined): Promise<void> {
  if (tsconfigPath === undefined) return;
  const raw = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, "utf8"));
  if (raw.error !== undefined) return; // let tsc surface the tsconfig error itself
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(tsconfigPath));
  const uwkFiles = parsed.fileNames.filter(isUwkSource);

  const entries: { source: string; ns: WorkletNamespace }[] = [];
  const failures: { file: string; reason: string }[] = [];
  for (const file of uwkFiles) {
    try {
      const processor = await loadUwkProcessor(file);
      entries.push({ source: file, ns: processor.worklet });
    } catch (err) {
      // A subgraph library is a `.uwk.ts` with exports and no `process()` — the
      // documented multi-file layout. The tsconfig includes it, so it reaches
      // here, and "not a processor" is the correct answer for it, not a failure:
      // it has no `?worklet` surface to witness, and treating it as broken made
      // the recommended layout exit 1.
      if (err instanceof NotAProcessorError) continue;
      failures.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (failures.length > 0) {
    // Reported after tsc, so tsc's diagnostics come first: for a file that fails
    // to load BECAUSE of a type error, tsc's account is the precise one and ours
    // would only bury it. `runTsc` exits the process itself, and an `exit`
    // listener is the supported way to raise a zero from there.
    process.on("exit", (code) => {
      for (const { file, reason } of failures) {
        console.error(`\n${path.relative(process.cwd(), file)}: cannot be compiled.\n  ${reason}`);
      }
      console.error(
        `\n@unworklet/lang: ${failures.length} processor(s) could not be compiled, so their ` +
          `\`?worklet\` imports fall back to \`CompiledProcessor<unknown>\` and real payload / ` +
          `state / event errors in code that uses them go unreported. Failing the run rather ` +
          `than passing on a witness that is known to be incomplete.\n`,
      );
      if (code === 0) process.exitCode = 1;
    });
  }

  // Next to the tsconfig being checked — the same directory `seedUnworkletDir`
  // used — so `--project sub/tsconfig.json` writes `sub/.unworklet/`.
  const witnessDir = path.join(path.dirname(tsconfigPath), ".unworklet");
  fs.mkdirSync(witnessDir, { recursive: true });
  const witnessPath = path.join(witnessDir, "worklets.d.ts");
  const existing = fs.existsSync(witnessPath) ? fs.readFileSync(witnessPath, "utf8") : "";
  const next = `${foreignWitnessBlocks(existing)}${workletsDts(entries)}`;
  // Only on change: the dev-server watcher fires on mtime, and rewriting an
  // unchanged generated file is enough to start a rebuild loop.
  if (next !== existing) fs.writeFileSync(witnessPath, next);
}

await populateWorkletsWitness(projectConfig);

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
