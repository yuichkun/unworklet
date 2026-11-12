/**
 * Write `dist/worklet-runtime.mjs` (typed by `src/worklet-runtime.d.ts`, copied
 * to `dist/worklet-runtime.d.mts`): the worklet runtime
 * (`makeWorkletNamespaceFromMeta`) bundled into ONE self-contained IIFE that
 * assigns `globalThis.__uwkMakeNs`, exported as a string.
 *
 * A runtime-compiled worklet module is loaded from a Blob URL, which cannot
 * resolve imports (nor can Safari resolve any import in addModule()'d code), so
 * the runtime travels inside it as text —
 * `emitWorkletModuleSource(meta, { runtime: { kind: "inline", code } })`.
 *
 * `vite.config.ts` runs this from `pack.onSuccess`, after every `vp pack` build
 * (including `--watch` rebuilds, which empty `dist/` first). `buildSync` keeps it
 * synchronous: tsdown does not await `onSuccess`, and the async `build()` keeps a
 * service alive whose open handle hangs a one-shot build.
 */
import { copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildSync } from "esbuild";

export function writeWorkletRuntime(packageRoot: string): void {
  const runtime = buildSync({
    stdin: {
      contents:
        'import { makeWorkletNamespaceFromMeta } from "./src/worklet-entry.ts";\n' +
        "globalThis.__uwkMakeNs = makeWorkletNamespaceFromMeta;\n",
      resolveDir: packageRoot,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
  }).outputFiles[0]!.text;
  writeFileSync(
    path.join(packageRoot, "dist/worklet-runtime.mjs"),
    `export default ${JSON.stringify(runtime)};\n`,
  );
  copyFileSync(
    path.join(packageRoot, "src/worklet-runtime.d.ts"),
    path.join(packageRoot, "dist/worklet-runtime.d.mts"),
  );
}
