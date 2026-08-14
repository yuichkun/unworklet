import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CompiledProcessor } from "@unworklet/core";
import ts from "typescript";

import { lower } from "./lower.ts";
import {
  plainTsModuleSpecifiers,
  rewriteImportSpecifiers,
  uwkImportSpecifiers,
} from "./uwk-imports.ts";

/** True for a `.uwk.ts` source path (the sugar RFC-001 lowers to a plain `.ts`). */
export const isUwkSource = (filePath: string): boolean => filePath.endsWith(".uwk.ts");

/**
 * Derive a valid camelCase JS identifier from a `.uwk.ts` filename — the single
 * named export the lowered module exposes (and the `registerProcessor` prefix).
 * The `.uwk.ts` suffix is stripped and kebab/snake segments are camel-cased, so
 * `noise-drive.uwk.ts` → `noiseDrive`; a name with no identifier characters
 * (`123.uwk.ts`) falls back to `processor`.
 */
export const deriveExportName = (sourcePath: string): string => {
  const base = path.basename(sourcePath).replace(/\.uwk\.ts$/, "");
  const camel = base
    .split(/[^A-Za-z0-9]+/)
    .filter((seg) => seg.length > 0)
    .map((seg, i) => (i === 0 ? seg : seg[0]!.toUpperCase() + seg.slice(1)))
    .join("")
    .replace(/^[^A-Za-z_$]+/, "");
  if (camel.length === 0) return "processor";
  // `class.uwk.ts` would otherwise emit `export const class = defineProcessor(…)`,
  // which is a syntax error, so the temp fails to load at all. Suffix rather than
  // replace, so the name still points back at the file.
  return RESERVED_WORDS.has(camel) ? `${camel}Processor` : camel;
};

/**
 * Words that cannot be a `const` binding. Reserved words plus the contextual ones
 * that are still errors in a module (modules are always strict, and `await` is
 * reserved at module top level).
 */
const RESERVED_WORDS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * Memoize `lower()` by (path, content): callers re-evaluate the same source
 * several times per operation (virtual load + worklet entry + middleware in the
 * plugin path) and each `lower()` builds a fresh in-memory ts.Program, so
 * caching the desugared text keeps that cost off the hot path. Keyed by path,
 * invalidated on content change.
 */
const loweredCache = new Map<string, { source: string; lowered: string }>();
export const lowerUwkSource = (sourcePath: string, source: string): string => {
  const cached = loweredCache.get(sourcePath);
  if (cached !== undefined && cached.source === source) return cached.lowered;
  // Thread the real path so the type-directed program roots its virtuals in the
  // source's directory — required for sibling `.uwk.ts` subgraph imports to
  // resolve during the sugar passes' type queries (bare-state auto-read,
  // operator dispatch, isDspExpr structural fallback). Guidance-dogfood F-08.
  const lowered = lower(source, {
    exportName: deriveExportName(sourcePath),
    sourcePath,
  });
  loweredCache.set(sourcePath, { source, lowered });
  return lowered;
};

/**
 * Lower `sourcePath` to a temp sibling and recursively lower the transitive
 * `.uwk.ts` imports it makes — a processor importing a subgraph from a sibling
 * library `.uwk.ts` — rewriting each importer's specifier to point at the lowered
 * sibling. Returns the entry temp path; every temp written is pushed to `cleanup`.
 *
 * Each temp is emitted as JavaScript (`.uwklowered.mjs`), not TypeScript. The
 * lowering produces TypeScript, and importing that directly would depend on
 * Node's native type-stripping — unavailable before 22.18 / 23.6, so a consumer
 * on the `>=20` this package declares would get `ERR_UNKNOWN_FILE_EXTENSION`
 * instead of a processor. `ts.transpileModule` strips the types here rather than
 * making that Node's problem; it is per-file and needs no type information, which
 * is all the lowered output requires.
 *
 * The `.uwklowered.` infix (not `.uwk.ts`) keeps a temp from ever being
 * re-lowered, and temps sit next to their source so `@unworklet/core` and any
 * plain relative imports resolve from the source directory. A single-file
 * processor (no `.uwk.ts` imports) writes exactly one temp.
 *
 * Low-level: the caller is responsible for the dynamic `import()` on the returned
 * path and for the cleanup pass at the end. High-level wrappers use this to
 * evaluate a `.uwk.ts` end-to-end (see the Vite plugin's
 * `loadProcessorModuleFresh` and offline / test usage).
 */
export const materializeLowered = async (
  entryPath: string,
  done: Map<string, string>,
  inProgress: Set<string>,
  cleanup: string[],
): Promise<string> => {
  // Resolve up front. A relative input (the documented `"./my-synth.uwk.ts"`)
  // otherwise fails twice: the lowering's program cannot locate it, and
  // `path.join(".", ".x.uwklowered.mjs")` yields a name with no `./` prefix,
  // which `import()` reads as a bare specifier.
  const sourcePath = path.resolve(entryPath);
  const already = done.get(sourcePath);
  if (already !== undefined) return already;
  if (inProgress.has(sourcePath)) {
    throw new Error(`@unworklet/lang: cyclic .uwk.ts import involving ${sourcePath}`);
  }
  inProgress.add(sourcePath);
  const source = await readFile(sourcePath, "utf8");
  let lowered = lowerUwkSource(sourcePath, source);
  const dir = path.dirname(sourcePath);
  const remap: Record<string, string> = {};
  for (const spec of uwkImportSpecifiers(lowered)) {
    const targetTemp = await materializeLowered(path.resolve(dir, spec), done, inProgress, cleanup);
    let rel = path.relative(dir, targetTemp).split(path.sep).join("/");
    // The temp basename is a dotfile (`.x.<tag>.uwklowered.mjs`), so a same-dir
    // `path.relative` yields a leading-dot name that Node would read as a bare
    // specifier — force an explicit `./` (or keep an existing `../`).
    if (!rel.startsWith("./") && !rel.startsWith("../")) rel = `./${rel}`;
    remap[spec] = rel;
  }
  if (Object.keys(remap).length > 0) lowered = rewriteImportSpecifiers(lowered, remap);
  // Strip types here so the temp is plain ESM every supported Node can import.
  // `sourcePath` is passed as the file name purely for diagnostics.
  const emitted = ts.transpileModule(lowered, {
    fileName: sourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      // Keep import specifiers exactly as the lowering wrote them — the sibling
      // remap above already points them at the temps.
      verbatimModuleSyntax: false,
    },
  }).outputText;
  // A plain `./helper.ts` the author imported survives lowering as-is, so the
  // temp — JavaScript though it is — still points at raw TypeScript. Only a Node
  // that strips types can load that, and this package supports older ones.
  //
  // We do NOT transpile the author's own modules to make it work: without their
  // tsconfig we would be guessing settings that change meaning (type-only import
  // elision, decorators, class field semantics), and silently altering user code
  // is not something this toolchain does. Fail loudly and name the two ways out.
  //
  // Read from the emit, not from the lowered source: which specifiers survive is
  // a property of the emit (a type-only or unused binding is dropped), so
  // predicting it from the AST reports files Node never asks for. Absent, not
  // false, is what Node 20 reports for the capability — the property only exists
  // once the capability does, so comparing against `false` would skip the check
  // on the exact runtime it is here for.
  if (!process.features.typescript) {
    const plain = plainTsModuleSpecifiers(emitted);
    if (plain.length > 0) {
      throw new Error(
        `@unworklet/lang: ${path.basename(sourcePath)} imports ${plain.map((s) => `"${s}"`).join(", ")}, ` +
          `and this Node (${process.version}) cannot load TypeScript. Either run Node 22.18+ / 23.6+, ` +
          `where type-stripping is built in, or give the helper a JavaScript extension ` +
          `(rename to .mjs and import it as "./helper.mjs"). Sibling .uwk.ts imports are ` +
          `unaffected — those are lowered to JavaScript for you.`,
      );
    }
  }
  const tag = createHash("sha256").update(emitted).digest("hex").slice(0, 8);
  const tempPath = path.join(dir, `.${path.basename(sourcePath)}.${tag}.uwklowered.mjs`);
  await writeFile(tempPath, emitted);
  done.set(sourcePath, tempPath);
  inProgress.delete(sourcePath);
  cleanup.push(tempPath);
  return tempPath;
};

/**
 * `.uwk.ts` shape check: a compiled processor has `graph` and a string `schemaHash`.
 * (Duplicated with the plugin's own check — the shape is stable / small; keeping it
 * local avoids a public `@unworklet/core` API for this one predicate.)
 */
const isCompiledProcessor = (v: unknown): v is CompiledProcessor<unknown> =>
  typeof v === "object" &&
  v !== null &&
  "graph" in v &&
  "schemaHash" in v &&
  typeof (v as { schemaHash: unknown }).schemaHash === "string";

/**
 * Load a `.uwk.ts` file (and its transitive `.uwk.ts` imports) from disk and
 * evaluate it to a `CompiledProcessor` — the offline / test equivalent of the
 * Vite plugin's `?worklet` build-path import. Materializes each `.uwk.ts` to a
 * lowered temp sibling, imports the entry via Node's native `import()`, picks
 * the single exported `defineProcessor(...)` return value, and cleans the temp
 * siblings up before returning.
 *
 * ```ts
 * import { loadUwkProcessor } from "@unworklet/lang";
 * import { renderOffline } from "@unworklet/offline";
 * const proc = await loadUwkProcessor("./my-synth.uwk.ts");
 * const result = await renderOffline(proc, { sampleRate: 48000, duration: 1 });
 * ```
 *
 * Multiple processors per file (or none) throw with an actionable message
 * (`v1.0.0` supports one processor per `.uwk.ts`).
 */
export async function loadUwkProcessor(sourcePath: string): Promise<CompiledProcessor<unknown>> {
  const cleanup: string[] = [];
  // Inside the try: materialization writes each sibling temp as it recurses, so a
  // failure partway (a sibling lowers, then the entry is rejected) would strand
  // those files in the consumer's source tree if cleanup only started afterwards.
  try {
    const entryTemp = await materializeLowered(sourcePath, new Map(), new Set(), cleanup);
    // A file URL, not a path: an absolute POSIX path happens to work, but a
    // Windows path or a name without a `./` prefix does not.
    const href = `${pathToFileURL(entryTemp).href}?t=${Date.now()}`;
    const mod = (await import(href)) as Record<string, unknown>;
    const matches: string[] = [];
    let found: CompiledProcessor<unknown> | undefined;
    for (const key of Object.keys(mod)) {
      if (isCompiledProcessor(mod[key])) {
        matches.push(key);
        found = mod[key] as CompiledProcessor<unknown>;
      }
    }
    if (matches.length === 0) {
      throw new Error(
        `@unworklet/lang: ${sourcePath} has no defineProcessor exports (a named export of ` +
          `defineProcessor(...) return value is required).`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `@unworklet/lang: ${sourcePath} has multiple defineProcessor exports ` +
          `(${matches.join(", ")}); v1.0.0 supports one processor per file.`,
      );
    }
    return found!;
  } finally {
    await Promise.all(cleanup.map((p) => rm(p, { force: true })));
  }
}
