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

const CORE_MODULE = "@unworklet/core";
const CORE_KEYS = Object.keys(core).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));

/**
 * Turn a lowered `.ts` module into a runnable `new Function` body, operating on the
 * parsed AST (not the emitted text — a regex would false-match an `export default`
 * / `import ... from` inside a comment or string literal in the authored body):
 *
 * - drop the `@unworklet/core` import (its names are injected as function params);
 * - rewrite `export default <expr>` into `return <expr>`.
 *
 * A non-core import is a cross-file import the in-memory / browser runtime cannot
 * resolve (no module loader, no filesystem); a missing default export is a library
 * module, not a processor. Both are surfaced as actionable errors rather than the
 * opaque `SyntaxError: Cannot use import statement` that `new Function` throws.
 */
function toRunnableBody(loweredTs: string): string {
  // 1. Strip types, keep ESM — transpileModule passes import/export through and
  //    elides unused imports (so an unused cross-file import drops out harmlessly).
  const jsEsm = ts.transpileModule(loweredTs, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  // 2. Parse the type-free JS and walk its statements, printing each into the
  //    function body — drop the `@unworklet/core` import (its names are injected as
  //    params) and turn `export default <expr>` into `return <expr>`. Decisions are
  //    made on AST nodes, so an `export default` / `import` sitting inside a comment
  //    or string literal in the authored body is ignored. Assembling the body from
  //    printed nodes also avoids the trailing `export {}` marker `transpileModule`
  //    would otherwise append once the module syntax is removed.
  const sf = ts.createSourceFile(
    "__lowered.js",
    jsEsm,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const parts: string[] = [];
  let sawDefault = false;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "";
      if (spec !== CORE_MODULE) {
        throw new Error(
          "unworklet: a .uwk.ts compiled in the browser / in-memory runtime cannot import " +
            `from other files (found "${spec}"). Cross-file imports resolve through the ` +
            "bundler (`?worklet`) build path; in the runtime-compile path, inline the value instead.",
        );
      }
      continue; // drop the core import
    }
    if (ts.isExportAssignment(stmt) && stmt.isExportEquals !== true) {
      sawDefault = true;
      const ret = ts.factory.createReturnStatement(stmt.expression);
      parts.push(printer.printNode(ts.EmitHint.Unspecified, ret, sf));
      continue;
    }
    parts.push(printer.printNode(ts.EmitHint.Unspecified, stmt, sf));
  }
  if (!sawDefault) {
    throw new Error(
      "unworklet: this .uwk.ts is a library module (no process()), not a processor. " +
        "It exports values (e.g. a defineSubgraph) for a processor to import; render the " +
        "processor that imports and instantiate()s it, not this file.",
    );
  }
  return parts.join("\n");
}

/**
 * Run a lowered `.ts` processor module to its `CompiledProcessor`, with the real
 * core exports injected as parameters (no module resolution). See {@link toRunnableBody}.
 */
export function evalLowered(loweredTs: string): CompiledProcessor<unknown> {
  const body = toRunnableBody(loweredTs);
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
