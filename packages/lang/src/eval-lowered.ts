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
  const body = js
    .replace(/import\s*\{[^}]*\}\s*from\s*["']@unworklet\/core["'];?/g, "")
    .replace(/export\s+default\s+/, "return ");
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
