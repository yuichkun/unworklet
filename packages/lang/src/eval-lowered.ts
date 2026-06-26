/**
 * Lower a `.uwk.ts` source to a runnable `CompiledProcessor` — the node-safe core
 * of the browser runtime-compile path (no DOM). `browser.ts` wraps the result in
 * Blob URLs; tests + `@unworklet/offline` can use it directly.
 */
import * as core from "@unworklet/core";
import type { CompiledProcessor } from "@unworklet/core";
import ts from "typescript";

import { lower } from "./lower.ts";
import type { FsSnapshot } from "./program.ts";

const CORE_KEYS = Object.keys(core);

/**
 * Strip the lowered module's `@unworklet/core` import + default export, then run
 * it with the real core exports injected as parameters (the golden harness's
 * `evalLowered`).
 */
export function evalLowered(loweredTs: string): CompiledProcessor<unknown> {
  const js = ts.transpileModule(loweredTs, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  // A processor lowers to `export default defineProcessor(...)`. No default export
  // means a library module (`export const x = defineSubgraph(...)`, no process()) —
  // not a processor, so there is nothing to render here. Surface that rather than
  // crashing in `new Function` on the surviving named `export`.
  if (!/export\s+default\s+/.test(js)) {
    throw new Error(
      "unworklet: this .uwk.ts is a library module (no process()), not a processor. " +
        "It exports values (e.g. a defineSubgraph) for a processor to import; render the " +
        "processor that imports and instantiate()s it, not this file.",
    );
  }
  const body = js
    .replace(/import\s*\{[^}]*\}\s*from\s*["']@unworklet\/core["'];?/g, "")
    .replace(/export\s+default\s+/, "return ");
  // Any import left after stripping the core one is a cross-file import (sharing a
  // constant / helper from a sibling). The in-memory / browser runtime-compile path
  // evaluates the module via `new Function`, which has no module loader and no
  // filesystem — so it cannot resolve them. Surface that as an actionable error
  // rather than the opaque `SyntaxError: Cannot use import statement` Function throws.
  const residual = /(?:^|\n)\s*(?:import|export)\b[^\n]*\bfrom\b/.exec(body);
  if (residual !== null) {
    throw new Error(
      "unworklet: a .uwk.ts compiled in the browser / in-memory runtime cannot import " +
        `from other files (found \`${residual[0].trim()}\`). Cross-file imports resolve ` +
        "through the bundler (`?worklet`) build path; in the runtime-compile path, inline " +
        "the value instead.",
    );
  }
  // The injected identifiers ARE the real core exports — equivalent to importing them.
  // oxlint-disable-next-line typescript/no-implied-eval
  const fn = new Function(...CORE_KEYS, body) as (...args: unknown[]) => CompiledProcessor<unknown>;
  return fn(...CORE_KEYS.map((k) => (core as Record<string, unknown>)[k]));
}

/**
 * Lower + evaluate a `.uwk.ts` source to a raw `CompiledProcessor`. The snapshot
 * is optional: in Node, `lower()` resolves the `@unworklet/core` types from disk,
 * so the offline / test path passes nothing; the browser entry passes its bundled
 * snapshot so `lower()` runs with no filesystem.
 */
export function lowerToProcessor(
  source: string,
  snapshot?: FsSnapshot,
): CompiledProcessor<unknown> {
  return evalLowered(lower(source, snapshot ? { snapshot } : {}));
}
