/**
 * `@unworklet/vite-plugin` — Vite plugin for `@unworklet/core` processors
 * (`07-vite-plugin.md`).
 *
 * Responsibilities (= `07-vite-plugin.md` §1):
 * 1. WASM compile invocation (= calls `@unworklet/core`'s `compile`)
 * 2. Asset resolution (= `?worklet` query)
 * 3. HMR boundary (= mark `?worklet` imports as Vite HMR boundaries)
 * 4. Source maps (= `.ts` → AST → `.wasm` propagation as `.wasm.map`)
 * 5. DevTools panels + analysis JSON artifact contract
 *
 * Stub stage: plugin factory + public type surface declared here;
 * runtime behavior is impl-phase fill.
 */

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
// Plugin factory
// ─────────────────────────────────────────────────────────────────────────

/**
 * Construct the Vite plugin instance. Default export per Vite convention;
 * also re-exported as a named export `unworklet` for explicit import.
 */
export default function unworklet(_options?: UnworkletPluginOptions): Plugin {
  throw new Error("not implemented");
}

export { unworklet as unworkletPlugin };
