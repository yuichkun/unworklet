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
  return { languagePlugins: [createUwkLanguagePlugin(ts)] };
});
