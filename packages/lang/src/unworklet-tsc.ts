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
 */
import { createRequire } from "node:module";
import path from "node:path";

import { runTsc } from "@volar/typescript/lib/quickstart/runTsc.js";

import { createUwkLanguagePlugin } from "./ide/languagePlugin.ts";

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
