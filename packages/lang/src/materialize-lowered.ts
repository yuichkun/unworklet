import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CompiledProcessor } from "@unworklet/core";

import { lower } from "./lower.ts";
import { rewriteImportSpecifiers, uwkImportSpecifiers } from "./uwk-imports.ts";

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
  return camel.length > 0 ? camel : "processor";
};

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
  const lowered = lower(source, { exportName: deriveExportName(sourcePath) });
  loweredCache.set(sourcePath, { source, lowered });
  return lowered;
};

/**
 * Lower `sourcePath` to a temp sibling and recursively lower the transitive
 * `.uwk.ts` imports it makes — a processor importing a subgraph from a sibling
 * library `.uwk.ts` — rewriting each importer's specifier to point at the lowered
 * sibling. Returns the entry temp path; every temp written is pushed to `cleanup`.
 *
 * `.uwklowered.ts` suffix (not `.uwk.ts`) so a temp is never re-lowered; written
 * next to its source so Node's native type-stripping runs and `@unworklet/core`
 * (+ plain `.ts` imports) resolve from the source directory. A single-file
 * processor (no `.uwk.ts` imports) writes exactly one temp.
 *
 * Low-level: the caller is responsible for the dynamic `import()` on the returned
 * path and for the cleanup pass at the end. High-level wrappers use this to
 * evaluate a `.uwk.ts` end-to-end (see the Vite plugin's
 * `loadProcessorModuleFresh` and offline / test usage).
 */
export const materializeLowered = async (
  sourcePath: string,
  done: Map<string, string>,
  inProgress: Set<string>,
  cleanup: string[],
): Promise<string> => {
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
    // The temp basename is a dotfile (`.x.<tag>.uwklowered.ts`), so a same-dir
    // `path.relative` yields a leading-dot name that Node would read as a bare
    // specifier — force an explicit `./` (or keep an existing `../`).
    if (!rel.startsWith("./") && !rel.startsWith("../")) rel = `./${rel}`;
    remap[spec] = rel;
  }
  if (Object.keys(remap).length > 0) lowered = rewriteImportSpecifiers(lowered, remap);
  const tag = createHash("sha256").update(lowered).digest("hex").slice(0, 8);
  const tempPath = path.join(dir, `.${path.basename(sourcePath)}.${tag}.uwklowered.ts`);
  await writeFile(tempPath, lowered);
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
  const entryTemp = await materializeLowered(sourcePath, new Map(), new Set(), cleanup);
  try {
    const mod = (await import(`${entryTemp}?t=${Date.now()}`)) as Record<string, unknown>;
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
