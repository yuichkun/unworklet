/**
 * `@unworklet/vite-plugin` — Vite plugin for `@unworklet/core` processors
 * (`07-vite-plugin.md`).
 *
 * Responsibilities (= `07-vite-plugin.md` §1):
 * 1. WASM compile invocation (= calls `@unworklet/core`'s `compile`)
 * 2. Asset resolution (= `?worklet` query)
 * 3. HMR boundary (= mark `?worklet` imports as Vite HMR boundaries; Phase 12)
 * 4. Source maps (= `.ts` → AST → `.wasm` propagation as `.wasm.map`; Phase 12)
 * 5. DevTools panels + analysis JSON artifact contract
 *
 * Phase 5 ship surface (per `10-roadmap.md` §Phase 5): real `Plugin` shell
 * + `?worklet` resolve / load + `compile()` invocation + 4 metadata
 * artifact JSON emit + initial 3 DevTools panels.
 */

import path from "node:path";

import type { Plugin } from "vite-plus";

// ─────────────────────────────────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────────────────────────────────

export type UnworkletPluginOptions = {
  /**
   * Whether to emit analysis JSON artifacts to `dist/` during `vite build`.
   * Default `true`.
   */
  emitAnalysisArtifacts?: boolean;
  /** Glob patterns / file paths to treat as processor sources. */
  include?: string[];
  /** Glob patterns / file paths to exclude. */
  exclude?: string[];
};

// ─────────────────────────────────────────────────────────────────────────
// Analysis JSON artifact contract (= `07-vite-plugin.md` §6.3)
// ─────────────────────────────────────────────────────────────────────────
//
// Concrete byte-layout / JSON schema detail per artifact is impl-phase fill
// (Q61). These types name the surfaces; third-party panels / CI integrations
// read these same files (= public extension surface).

/** `dist/<processor>.graph.json` — AST DAG view (per-block + forSample loops + declarations). */
export type GraphArtifact = {
  readonly __graphArtifact: unique symbol;
};

/** `dist/<processor>.memory.json` — per-declaration byte counts (Q30 auto-sum). */
export type MemoryArtifact = {
  readonly __memoryArtifact: unique symbol;
};

/** `dist/<processor>.diagnostics.json` — 3-layer error / warning list with stable IDs. */
export type DiagnosticsArtifact = {
  readonly __diagnosticsArtifact: unique symbol;
};

/** `dist/<processor>.schema-hash.json` — migration anchor (`01-dsl.md` §8.3). */
export type SchemaHashArtifact = {
  readonly __schemaHashArtifact: unique symbol;
};

// ─────────────────────────────────────────────────────────────────────────
// Virtual id convention for `?worklet` imports
// ─────────────────────────────────────────────────────────────────────────
//
// Vite plugin の慣用 = null byte (`\0`) prefix で virtual module を 示す。
// `\0unworklet:<absolute-source-path>` を load hook で 認 識 し、 中 身 を
// `compile(processor)` 経 由 で 生 成 し た WASM URL に 置 換 (= 5-D 以 降)。

const VIRTUAL_ID_PREFIX = "\0unworklet:";
const WORKLET_QUERY_PARAM = "worklet";

const detectWorkletQuery = (source: string): { basePath: string } | null => {
  const queryIdx = source.indexOf("?");
  if (queryIdx < 0) return null;
  const params = new URLSearchParams(source.slice(queryIdx + 1));
  if (!params.has(WORKLET_QUERY_PARAM)) return null;
  return { basePath: source.slice(0, queryIdx) };
};

const resolveAgainstImporter = (
  basePath: string,
  importer: string | undefined,
): string | undefined => {
  if (path.isAbsolute(basePath)) return basePath;
  if (!importer) return undefined;
  return path.resolve(path.dirname(importer), basePath);
};

// ─────────────────────────────────────────────────────────────────────────
// Plugin factory
// ─────────────────────────────────────────────────────────────────────────

/**
 * Construct the Vite plugin instance. Default export per Vite convention;
 * also re-exported as a named export `unworklet` for explicit import.
 *
 * Phase 5-C status:
 * - `name` declared
 * - `resolveId` translates `?worklet` imports into `\0unworklet:<abs>` virtual ids
 * - `load` returns a placeholder JS module for those virtual ids
 *   (= `compile()` invocation + WASM emit + actual URL are filled in 5-D).
 */
export default function unworklet(_options?: UnworkletPluginOptions): Plugin {
  return {
    name: "@unworklet/vite-plugin",
    resolveId(source, importer) {
      const detect = detectWorkletQuery(source);
      if (!detect) return undefined;
      const resolved = resolveAgainstImporter(detect.basePath, importer);
      if (!resolved) return undefined;
      return `${VIRTUAL_ID_PREFIX}${resolved}`;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_ID_PREFIX)) return undefined;
      // 5-C placeholder; 5-D replaces with the emitted WASM asset URL.
      return "export default null;\n";
    },
  };
}

export { unworklet as unworkletPlugin };
