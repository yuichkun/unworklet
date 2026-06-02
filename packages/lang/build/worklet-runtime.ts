/**
 * Bundle `@unworklet/core/worklet` into ONE self-contained IIFE that assigns
 * `globalThis.__uwkMakeNs`. `emitWorkletModuleSource(..., { runtime: inline })`
 * inlines this verbatim into each generated worklet module so it needs no import
 * — Safari can't resolve imports in addModule()'d code, and a Blob module can't
 * resolve bare/sibling specifiers.
 *
 * `vite.browser.config.ts` calls this at build time and `define`s the result.
 * `buildSync` runs esbuild as a one-shot child (the async `build()` keeps a
 * persistent service alive whose open handle hangs a one-shot CI build).
 */
import { buildSync } from "esbuild";

export function bundleWorkletRuntime(): string {
  const result = buildSync({
    stdin: {
      contents:
        'import { makeWorkletNamespaceFromMeta } from "@unworklet/core/worklet";\n' +
        "globalThis.__uwkMakeNs = makeWorkletNamespaceFromMeta;\n",
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  return result.outputFiles[0]!.text;
}
