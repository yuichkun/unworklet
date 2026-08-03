/**
 * `@unworklet/unplugin` — Vite plugin for `@unworklet/core` processors
 * (`07-unplugin.md`).
 *
 * Responsibilities (= `07-unplugin.md` §1):
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

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile, extractWorkletMeta } from "@unworklet/core";
import type { CompiledProcessor, WorkletNamespace } from "@unworklet/core";
import { isUwkSource, lowerUwkSource, materializeLowered, seedUnworkletDir } from "@unworklet/lang";
import { createUnplugin, type UnpluginOptions } from "unplugin";
import type { Plugin } from "vite";

import { workletsDts } from "./worklet-dts.ts";

// ─────────────────────────────────────────────────────────────────────────
// DevTools live audio-graph topology (Wire 4)
// ─────────────────────────────────────────────────────────────────────────
//
// The dev page-script (injected in serve mode) monkey-patches
// `AudioNode.prototype.connect/disconnect` and reads the `@unworklet/core/dev`
// live-node registry to build the real Web-Audio graph, then pushes it here via
// the `unworklet:graph-update` action RPC. The server mirrors it into the
// `unworklet:graph` shared state, which the iframe Audio-graph panel renders.
// No app code is involved (zero-config); WASM memory is never read for this.

/** One node in the live audio graph. */
export type DevGraphNode = {
  id: string;
  label: string;
  kind: "unworklet" | "standard";
  audioNodeType: string;
  /** Declared audio port names (unworklet nodes only). */
  inputs?: string[];
  outputs?: string[];
};
/** One directed audio connection. */
export type DevGraphEdge = { id: string; from: string; to: string };
export type DevAudioGraph = { nodes: DevGraphNode[]; edges: DevGraphEdge[] };

// ─────────────────────────────────────────────────────────────────────────
// DevTools live state X-ray (devDump)
// ─────────────────────────────────────────────────────────────────────────
//
// The page-script polls each live node's `devDump()` (the worklet copies its
// WASM slots into bytes), decodes every slot, and pushes them here via the
// `unworklet:state-update` action RPC; the server mirrors them into the
// `unworklet:state` shared state the Live-state panel reads. Buffers larger than
// `BUFFER_MAX_POINTS` are stride-downsampled for the wire (full resolution is
// not needed to visualize them) — `length` always carries the true element count.

/** Element type of a slot's storage. */
export type DevSlotType = "f32" | "f64" | "i32" | "i64" | "bool" | "u8";
/** One scalar slot's live value (i64 is sent as a decimal string — JSON-safe). */
export type DevStateScalar = {
  name: string;
  kind: "state" | "param";
  type: DevSlotType;
  value: number | boolean | string;
};
/**
 * One buffer slot's live data. `data` is the decoded elements (numbers; bool/u8
 * as 0/1/byte), stride-downsampled when the buffer exceeds `BUFFER_MAX_POINTS`.
 * `length` is the true element count; `downsampled` flags a reduced `data`.
 */
export type DevStateBuffer = {
  name: string;
  type: DevSlotType;
  length: number;
  data: number[];
  downsampled: boolean;
};
export type DevNodeState = {
  id: string;
  displayName: string;
  scalars: DevStateScalar[];
  buffers: DevStateBuffer[];
};
export type DevLiveState = { nodes: DevNodeState[] };

// ─────────────────────────────────────────────────────────────────────────
// DevTools signals (AnalyserNode taps + declared memory)
// ─────────────────────────────────────────────────────────────────────────
//
// The page-script taps an AnalyserNode on each unworklet output port and pushes
// the live scope (time domain), normalized spectrum (frequency domain), and
// RMS/peak levels here via `unworklet:signals-update`. `memory` is the static
// declared linear-memory layout from a one-shot devDump. Per-node DSP timing is
// intentionally absent — it is not observable from the main thread; the panel
// surfaces the AudioContext's reported latencies instead.

export type DevSignalsPort = {
  name: string;
  /** Downsampled time-domain scope, samples in [-1, 1]. */
  time: number[];
  /** Normalized spectrum bins in [0, 1]. */
  freq: number[];
  rms: number;
  peak: number;
};
export type DevSignalsMemoryEntry = { name: string; kind: string; bytes: number };
export type DevSignalsNode = {
  id: string;
  displayName: string;
  ports: DevSignalsPort[];
  memory: DevSignalsMemoryEntry[];
  memoryBytes: number;
};
export type DevSignalsState = {
  nodes: DevSignalsNode[];
  context: { sampleRate: number; baseLatencyMs: number; outputLatencyMs: number };
};

// ─────────────────────────────────────────────────────────────────────────
// DevTools MIDI (real port traffic)
// ─────────────────────────────────────────────────────────────────────────
//
// The page-script taps `onEvent` on every outbound MIDI port for the live log,
// reads each port's real overflow counter, and drains a server-seq'd inject
// queue into `node.midi[port].send`. Directions: `out` events come straight from
// the worklet; `inject` entries are panel key/controller sends into a real input
// port. (A worklet's *inbound* traffic isn't observable from the main thread —
// the main thread is the sender — so there is no honest `in` log direction.)

export type DevMidiEvent =
  | { type: "noteOn"; channel: number; note: number; velocity: number }
  | { type: "noteOff"; channel: number; note: number; velocity: number }
  | { type: "cc"; channel: number; controller: number; value: number }
  | { type: "pitchBend"; channel: number; value: number }
  | { type: "programChange"; channel: number; program: number }
  | { type: "channelPressure"; channel: number; pressure: number }
  | { type: "aftertouch"; channel: number; note: number; pressure: number }
  | { type: "systemRealtime"; status: number }
  | { type: "sysex"; data: number[] };
export type DevMidiPort = {
  nodeId: string;
  node: string;
  name: string;
  direction: "in" | "out";
  overflow: number;
};
export type DevMidiLogEntry = {
  seq: number;
  ts: number;
  dir: "out" | "inject";
  nodeId: string;
  port: string;
  event: DevMidiEvent;
};
export type DevMidiState = { ports: DevMidiPort[]; log: DevMidiLogEntry[] };
export type DevMidiInjectCommand = {
  seq: number;
  nodeId: string;
  port: string;
  event: DevMidiEvent;
};
export type DevMidiInject = { commands: DevMidiInjectCommand[] };

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "unworklet:graph": DevAudioGraph;
    "unworklet:state": DevLiveState;
    "unworklet:signals": DevSignalsState;
    "unworklet:midi": DevMidiState;
    "unworklet:midi-inject": DevMidiInject;
  }
}

import { emitWorkletTemplate } from "./worklet-template.ts";

/**
 * Suffix appended to the processor export name to derive the
 * `AudioWorkletProcessor` registration name. AudioWorklet's
 * `registerProcessor(name, klass)` throws `NotSupportedError` on a
 * duplicate name within the same `BaseAudioContext.audioWorklet` AND has
 * no de-register API — once a name is taken inside a context, it is
 * taken forever for the lifetime of that context.
 *
 * Composition: `<exportName>__<srcHash8>__<revHash8>` where
 * - `srcHash8` = sha-8 of the absolute source path, separates two unrelated
 *   files that happen to share an export identifier (= e.g. both export
 *   `stereoGain` from different paths).
 * - `revHash8` = sha-8 of the compiled WASM bytes (= revision identity),
 *   so a new revision of the same source registers under a NEW name and
 *   can coexist with in-flight nodes from the previous revision until
 *   the consumer disposes them. This is the only browser-API-compliant
 *   path for forward-compatible `?worklet` HMR / `replaceProcessor`
 *   wiring (= `07-unplugin.md` §4, Q50).
 *
 * 8 hex chars per component = 32 bit. Collision probability across the
 * cartesian product of (source path × revision) is negligible for any
 * realistic project / dev session (birthday bound ~65k pairs for 1%).
 */
const PROCESSOR_NAME_HASH_LEN = 8;

const computeProcessorName = (
  exportName: string,
  absSourcePath: string,
  wasmBytes: Uint8Array,
): string => {
  const srcSuffix = createHash("sha256")
    .update(absSourcePath)
    .digest("hex")
    .slice(0, PROCESSOR_NAME_HASH_LEN);
  const revSuffix = createHash("sha256")
    .update(wasmBytes)
    .digest("hex")
    .slice(0, PROCESSOR_NAME_HASH_LEN);
  return `${exportName}__${srcSuffix}__${revSuffix}`;
};

/**
 * Re-import `sourcePath` with a mtime-based cache-buster query so Node's
 * ESM module cache returns the **current** disk content instead of the
 * cached evaluation from the first `import()`.
 *
 * Build-mode fallback only — dev mode goes through `ssrLoadModule` so the
 * full transitive import graph rides on Vite's module graph (= helper file
 * edits invalidate automatically = `07-unplugin.md` §3 dev/build symmetry).
 *
 * The buster appears as a URL query (= `?t=<mtimeMs>`). Node treats the
 * resulting specifier as a fresh module identity = forces re-evaluation.
 * Transitive imports inside the source (= e.g. `@unworklet/core`) are NOT
 * cache-busted = build mode never sees this because rolldown re-bundles
 * on each build run, but the comment is kept for the (rare) build code path
 * that still routes through here.
 */
const importFresh = async (sourcePath: string): Promise<Record<string, unknown>> => {
  const s = await stat(sourcePath);
  return (await import(`${sourcePath}?t=${s.mtimeMs}`)) as Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────
// `.uwk.ts` sugar lowering
// ─────────────────────────────────────────────────────────────────────────
//
// A `.uwk.ts` is sugar (RFC-001) that `@unworklet/lang`'s `lower()` desugars to a
// plain core `.ts` exporting a single named `defineProcessor(...)`. The plugin
// lowers it at every site that evaluates processor source: the `transform` hook
// covers the Vite/rolldown pipeline (dev `ssrLoadModule`, the dev WASM middleware,
// the consumer-bundle re-import), while the build path's raw Node `import()` is
// handled explicitly by `loadProcessorModuleFresh` — Node does not run Vite
// transforms. Both derive the export name from the filename identically, so the
// two evaluations of the same source agree on the export key + registration name.

// `isUwkSource`, `deriveExportName`, `lowerUwkSource`, and `materializeLowered`
// live in `@unworklet/lang` (imported above) so both the Vite plugin and offline
// / test callers share the same multi-file `.uwk.ts` lowering.

/**
 * Build-path module load. A plain `.ts` is imported fresh via Node; a `.uwk.ts`
 * is lowered (with its transitive `.uwk.ts` imports — see {@link materializeLowered})
 * to temp siblings, imported, then removed. (Node `import()` does not run the Vite
 * transform pipeline, so the build path cannot rely on the `transform` hook.)
 */
const loadProcessorModuleFresh = async (sourcePath: string): Promise<Record<string, unknown>> => {
  if (!isUwkSource(sourcePath)) return importFresh(sourcePath);
  const cleanup: string[] = [];
  const entryTemp = await materializeLowered(sourcePath, new Map(), new Set(), cleanup);
  try {
    return (await import(`${entryTemp}?t=${Date.now()}`)) as Record<string, unknown>;
  } finally {
    await Promise.all(cleanup.map((p) => rm(p, { force: true })));
  }
};

/**
 * `ssrLoadModule(...)` runs the source through Vite's dev-server module
 * loader = transitive imports show up in `server.moduleGraph` and the
 * watcher invalidates the virtual `?worklet` module when **any** of them
 * change. Without this path, editing a helper file imported by the
 * processor source leaves the dev server serving stale DSP = a clear
 * dev/build symmetry break.
 *
 * The vite ViteDevServer interface here is intentionally minimal — we only
 * need `ssrLoadModule` for evaluation and `moduleGraph.getModuleById` /
 * `importedModules` for the transitive watch fanout. Typing this against
 * the full `vite` server interface would force a vite dependency at
 * type-resolution time; the shape is well-known and stable.
 */
type ViteDevServerLike = {
  ssrLoadModule: (url: string) => Promise<Record<string, unknown>>;
  moduleGraph: {
    /**
     * Vite indexes the module graph by file path separately from by
     * resolved id — query suffixes, plugin-resolved virtuals, and
     * normalized URLs make `id` and `file` diverge in real code. The
     * file-based lookup returns **every** module node attached to a given
     * file path (since the same file can appear under multiple ids =
     * different `?...` queries). See vite.dev /guide /api-environment-
     * instances.
     */
    getModulesByFile: (file: string) => Set<ViteModuleNodeLike> | undefined;
  };
};

type ViteModuleNodeLike = {
  file?: string | null;
  importedModules: Set<ViteModuleNodeLike> | ReadonlyArray<ViteModuleNodeLike>;
};

const ssrLoadSource = async (
  server: ViteDevServerLike,
  sourcePath: string,
): Promise<Record<string, unknown>> => {
  // Force a fresh evaluation. Vite caches `ssrLoadModule`, so without a
  // cache-buster a `.processor.ts` edit is NOT reflected in dev until the dev
  // server restarts — the watcher reloads the virtual `?worklet` module (so
  // `load` re-runs), but `ssrLoadModule` keeps returning the stale evaluation,
  // so `compile` recompiles old source. Append an integer `?t=` buster (Vite's
  // own HMR cache-bust convention) so each load re-transforms + re-runs the
  // source.
  //
  // `Date.now()` rather than the source mtime: in dev `sourcePath` is a Vite
  // root-relative URL (e.g. `/src/x.ts`), NOT a filesystem path, so it can't be
  // `stat`-ed (the build path's `importFresh` resolves an absolute path and can).
  // An integer (no `.`) is required — a fractional query (`?t=123.45`) makes
  // Vite read the trailing digits as the file extension, dropping the `.ts`
  // transform. `compile` is deterministic, so re-evaluating unchanged source
  // still yields the same revision hash (= no spurious `replaceProcessor` churn);
  // only a real edit changes the WASM bytes → new hash → swap.
  return await server.ssrLoadModule(`${sourcePath}?t=${Date.now()}`);
};

/**
 * Recursively collect every file backing a module reachable from
 * `sourcePath` in the dev server's module graph. The returned `Set`
 * excludes `sourcePath` itself — the plugin's load hook is the canonical
 * watcher for the entry. Callers pass each transitive file through
 * `this.addWatchFile(...)` so vite re-runs `load` when any of them change.
 *
 * The traversal starts from `getModulesByFile(sourcePath)` (file-based
 * index) rather than `getModuleById(...)`: Vite stores the module under
 * possibly multiple ids for the same file (= query-suffixed variants,
 * plugin-resolved virtuals), so id-based lookup misses the dependency
 * fanout whenever `id !== sourcePath` exactly.
 */
const collectTransitiveDeps = (server: ViteDevServerLike, sourcePath: string): Set<string> => {
  const seen = new Set<string>();
  const queue: ViteModuleNodeLike[] = [];
  const roots = server.moduleGraph.getModulesByFile(sourcePath);
  if (!roots) return seen;
  for (const root of roots) {
    for (const imp of root.importedModules) queue.push(imp);
  }
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!node.file) continue;
    if (node.file === sourcePath) continue;
    if (seen.has(node.file)) continue;
    seen.add(node.file);
    for (const child of node.importedModules) queue.push(child);
  }
  return seen;
};

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the devtools-ui SPA dist directory across packed vs source layouts.
 * - Packed: `<pkg>/dist/ui` (= built artifact copied next to `dist/index.mjs`
 *   via the `scripts/build.mjs` orchestration)
 * - Source: `<pkg>/devtools-ui/dist` (= sub-project's own build output in dev)
 */
const resolveDevtoolsUiRoot = (): string => {
  const candidates = [
    path.join(PLUGIN_DIR, "ui"),
    path.resolve(PLUGIN_DIR, "..", "devtools-ui", "dist"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
};

// ─────────────────────────────────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────────────────────────────────

export type UnworkletPluginOptions = {
  /**
   * Whether to emit analysis JSON artifacts to `dist/` during `vite build`.
   * Default `true`.
   */
  emitAnalysisArtifacts?: boolean;
  /**
   * Make the dev server cross-origin isolated — COOP `same-origin` + COEP
   * `credentialless` — so `SharedArrayBuffer`, unworklet's fast main↔worklet
   * transport, works with no app config. Default `true`. `credentialless` is the
   * least-breaking isolation level: cross-origin subresources still load, just
   * without credentials. Set `false` if your app serves its own COOP/COEP headers;
   * an app that already sets either header is left untouched regardless. This
   * affects vite's dev and preview servers — production headers are always your
   * server's job.
   */
  crossOriginIsolation?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────
// Analysis JSON artifact contract (= `07-unplugin.md` §6.3)
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
// Vite plugin convention = a null-byte (`\0`) prefix marks a virtual module.
// The load hook recognizes `\0unworklet:<absolute-source-path>` and replaces
// its body with a WASM URL produced through `compile(processor)` (= 5-D onward).

const VIRTUAL_ID_PREFIX = "\0unworklet:";
const WORKLET_ENTRY_PREFIX = "\0unworklet-worklet:";
const WORKLET_QUERY_PARAM = "worklet";

/**
 * Virtual module id for the serve-only DevTools page bridge. The bridge is
 * injected as a `<script type="module" src>` rather than an inline script,
 * because Vite rewrites the bare imports of a real module it loads but NOT those
 * of an inline injected `<script>` (= the page would otherwise throw "Failed to
 * resolve module specifier @unworklet/core/dev").
 */
const DEVBRIDGE_ID = "\0unworklet-devbridge";

/**
 * URL prefix that the dev-server middleware (= `configureServer`) listens on.
 * `${base}__unworklet/<encoded-abs-source-path>/(worklet.js|wasm)`:
 * - `worklet.js` = the `AudioWorkletProcessor` wrapper served as JS, loaded
 *   via `audioWorklet.addModule(...)` on the main thread.
 * - `wasm` = the compiled WASM bytes, fetched on the main thread and handed
 *   to the worklet via `AudioWorkletNodeOptions.processorOptions.wasm`.
 *
 * Build mode emits the same two artifacts via `this.emitFile` so the
 * consumer-side import shape is identical (= dev / build symmetry per
 * `07-unplugin.md` §3 "Vite asset pipeline integration").
 */
const DEV_URL_PREFIX = "__unworklet";

const encodeSourceForDevUrl = (absPath: string): string =>
  Buffer.from(absPath, "utf8").toString("base64url");

const decodeSourceFromDevUrl = (encoded: string): string =>
  Buffer.from(encoded, "base64url").toString("utf8");

/**
 * 8-hex-char content hash over the compiled WASM bytes. Used in dev to
 * pin `moduleUrl` and `wasmUrl` to the same compile revision: both URLs
 * carry this token, so even if the author edits and saves between
 * `audioWorklet.addModule(...)` and `fetch(wasmUrl)` the original URLs
 * still resolve to the snapshot they were minted from (= no inline-meta
 * vs WASM bytes skew, `07-unplugin.md` §3 dev/build symmetry).
 */
const REVISION_HASH_LEN = 8;
const computeRevisionHash = (wasm: Uint8Array): string =>
  createHash("sha256").update(wasm).digest("hex").slice(0, REVISION_HASH_LEN);

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
// Source module → CompiledProcessor extraction
// ─────────────────────────────────────────────────────────────────────────
//
// v1.0.0 convention = one source file, one processor. As long as the
// `defineProcessor(...)` return value is a named export, the plugin picks
// that single one and hands it to `compile()`. Multiple exports / no export
// throw an error that prompts the user to refactor (= no surface change, just
// a reasonable default at the implementation level).

const isCompiledProcessor = (v: unknown): v is CompiledProcessor<unknown> => {
  return (
    typeof v === "object" &&
    v !== null &&
    "graph" in v &&
    "schemaHash" in v &&
    typeof (v as { schemaHash: unknown }).schemaHash === "string"
  );
};

type PickedProcessor = {
  exportName: string;
  processor: CompiledProcessor<unknown>;
};

const pickCompiledProcessor = (
  sourceModule: Record<string, unknown>,
  sourcePath: string,
): PickedProcessor => {
  const matches: string[] = [];
  let found: { exportName: string; processor: CompiledProcessor<unknown> } | undefined;
  for (const key of Object.keys(sourceModule)) {
    if (isCompiledProcessor(sourceModule[key])) {
      matches.push(key);
      found = { exportName: key, processor: sourceModule[key] as CompiledProcessor<unknown> };
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `@unworklet/unplugin: ${sourcePath} has no defineProcessor exports (a named export of \`defineProcessor(...)\` return value is required).`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `@unworklet/unplugin: ${sourcePath} has multiple defineProcessor exports (${matches.join(", ")}); v1.0.0 supports one processor per file.`,
    );
  }
  return found!;
};

const assetBaseName = (sourcePath: string): string => {
  let base = path.basename(sourcePath, path.extname(sourcePath));
  // Strip an optional `.processor` (= `foo.processor.ts`) or `.uwk`
  // (= `foo.uwk.ts`) suffix so emitted assets land at `dist/<processor>.<artifact>`,
  // zipping with the analysis-JSON convention in `07-unplugin.md` §6.3.
  if (base.endsWith(".processor")) base = base.slice(0, -".processor".length);
  if (base.endsWith(".uwk")) base = base.slice(0, -".uwk".length);
  return base;
};

/**
 * `JSON.stringify` replacer that renders a `bigint` (= an `i64` literal / state
 * `initial`) as a `"<n>n"` string — matching `schemaHash.ts`'s convention — so the
 * build-time analysis artifacts serialize as valid JSON instead of throwing
 * "Do not know how to serialize a BigInt".
 */
const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? `${value}n` : value;

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 final step 5-F DevTools — collapse everything into a single dock
// entry that hosts a Vue SPA
// ─────────────────────────────────────────────────────────────────────────
//
// The `devtools-ui/` Vue SPA is served as a single iframe panel through
// `ctx.views.hostStatic`. Inside the panel a sidebar switches between 4 views
// (= Audio graph / Live state / Signals / MIDI) via Vue Router = a deliberate
// choice not to crowd out other plugins (= Vue/Nuxt DevTools, etc.). Every panel
// receives the data the page-script gathered from the live nodes through
// sharedState (= graph / state / signals / midi).

const setupDevtools = async (
  ctx: import("@vitejs/devtools-kit").ViteDevToolsNodeContext,
  uiRoot: string,
): Promise<void> => {
  // Register the dock + host the panel SPA synchronously, before any await:
  // the dock must appear independently of the async graph-state wiring below
  // (and keeps setup robust if the devtools-kit import / shared-state handshake
  // is slow or unavailable).
  ctx.docks.register({
    id: "unworklet",
    title: "unworklet",
    icon: "ph:waveform-duotone",
    type: "iframe",
    url: "/__unworklet/",
    // The panel runs in an iframe the devtools host does NOT inject its client
    // context into (it only does that for the top page). Without `remote`, the
    // panel would self-connect as an anonymous client, and an anonymous RPC name
    // is version-coupled to the host's devtools-kit (`vite:anonymous:` in 0.2.x,
    // `devframe:anonymous:` in 0.3.x) — a panel built against one and embedded in
    // a host of the other is rejected (DTK0013) and renders empty. `remote` makes
    // the host inject a session auth token into the iframe URL; the panel calls
    // `connectRemoteDevTools()` and connects as a TRUSTED client, bypassing the
    // anonymous-scope check. Auth is then by token, not by a version-matched scope
    // string, so the panel works against any host the user's toolchain ships.
    //
    // `transport: "query"` (not the default `"fragment"`) is REQUIRED here: the
    // panel SPA uses a hash-mode Vue Router, so a descriptor placed in the URL
    // fragment is clobbered by the router before `connectRemoteDevTools()` reads
    // it (the panel then never connects and renders empty). The query string is
    // untouched by hash routing. Verified end-to-end against a real devtools host.
    remote: { transport: "query" },
  });
  ctx.views.hostStatic("/__unworklet/", uiRoot);

  // Live audio-graph topology — mirror the page-script's captured graph into a
  // shared state the Audio-graph panel reads (Wire 4). `@vitejs/devtools-kit` is
  // imported lazily (only when the devtools host actually drives setup) so the
  // plugin's module graph — and anything importing it, e.g. tests — does not
  // eagerly pull the devtools runtime.
  const { defineRpcFunction } = await import("@vitejs/devtools-kit");
  // The page-script (devbridge) pushes graph / state / signals / MIDI here, but it
  // is an UNTRUSTED devtools client (no auth token), so a normal RPC name is
  // rejected with DTK0013 "Unauthorized access to method" — and the 33ms signals
  // poll turns that into a console flood that blocks the panel. The only bypass is
  // `@vitejs/devtools`'s anonymous-method mechanism: a method whose name starts with
  // its internal `ANONYMOUS_SCOPE` skips the client-auth check. That scope is
  // version-coupled and unexported — `vite:anonymous:` in devtools 0.2.x,
  // `devframe:anonymous:` in 0.3.x — so the `@vitejs/devtools-kit` peer is pinned to
  // an exact 0.3 version (not a range): a mismatched version changes this prefix and
  // silently empties every panel. These pushes are dev-only, local, and
  // non-sensitive, so anonymous is the right scope. (MIDI inject below is called from
  // the trusted panel, not the page, so it needs no prefix.)
  const graphState = await ctx.rpc.sharedState.get("unworklet:graph", {
    initialValue: { nodes: [], edges: [] },
  });
  const graphUpdate = defineRpcFunction({
    name: "devframe:anonymous:unworklet:graph-update",
    type: "action",
    setup: () => ({
      handler: async (graph: DevAudioGraph): Promise<void> => {
        graphState.mutate((draft) => {
          draft.nodes = graph.nodes;
          draft.edges = graph.edges;
        });
      },
    }),
  });
  // `register()` takes the loosely-typed RpcFunctionDefinition union; defineRpcFunction
  // infers an argument-specific one (contravariant handler), so widen at the boundary.
  ctx.rpc.register(graphUpdate as Parameters<typeof ctx.rpc.register>[0]);

  // Live state X-ray — the page-script polls each node's devDump and pushes the
  // decoded scalar slots here; the Live-state panel reads `unworklet:state`.
  const liveState = await ctx.rpc.sharedState.get("unworklet:state", {
    initialValue: { nodes: [] },
  });
  const stateUpdate = defineRpcFunction({
    name: "devframe:anonymous:unworklet:state-update",
    type: "action",
    setup: () => ({
      handler: async (state: DevLiveState): Promise<void> => {
        liveState.mutate((draft) => {
          draft.nodes = state.nodes;
        });
      },
    }),
  });
  ctx.rpc.register(stateUpdate as Parameters<typeof ctx.rpc.register>[0]);

  // Signals — the page-script taps an AnalyserNode per output port and pushes
  // the live scope / spectrum / levels + declared memory here; the Signals
  // panel reads `unworklet:signals`.
  const signalsState = await ctx.rpc.sharedState.get("unworklet:signals", {
    initialValue: {
      nodes: [],
      context: { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 },
    },
  });
  const signalsUpdate = defineRpcFunction({
    name: "devframe:anonymous:unworklet:signals-update",
    type: "action",
    setup: () => ({
      handler: async (signals: DevSignalsState): Promise<void> => {
        signalsState.mutate((draft) => {
          draft.nodes = signals.nodes;
          draft.context = signals.context;
        });
      },
    }),
  });
  ctx.rpc.register(signalsUpdate as Parameters<typeof ctx.rpc.register>[0]);

  // MIDI — the page-script pushes live port traffic (out events + overflow) here
  // via `unworklet:midi-update`; the MIDI panel reads `unworklet:midi`.
  const midiState = await ctx.rpc.sharedState.get("unworklet:midi", {
    initialValue: { ports: [], log: [] },
  });
  const midiUpdate = defineRpcFunction({
    name: "devframe:anonymous:unworklet:midi-update",
    type: "action",
    setup: () => ({
      handler: async (midi: DevMidiState): Promise<void> => {
        midiState.mutate((draft) => {
          draft.ports = midi.ports;
          draft.log = midi.log;
        });
      },
    }),
  });
  ctx.rpc.register(midiUpdate as Parameters<typeof ctx.rpc.register>[0]);

  // MIDI inject — the panel's virtual keyboard calls `unworklet:midi-inject`,
  // which appends a server-seq'd command to the `unworklet:midi-inject` shared
  // state the page-script drains into the real `node.midi[port].send`. The seq
  // (not state coalescing) keeps a fast burst — noteOn + its noteOff — intact.
  const INJECT_QUEUE_MAX = 64;
  let injectSeq = 0;
  const injectState = await ctx.rpc.sharedState.get("unworklet:midi-inject", {
    initialValue: { commands: [] },
  });
  const midiInject = defineRpcFunction({
    name: "unworklet:midi-inject",
    type: "action",
    setup: () => ({
      handler: async (cmd: Omit<DevMidiInjectCommand, "seq">): Promise<void> => {
        injectState.mutate((draft) => {
          const next: DevMidiInjectCommand = { seq: ++injectSeq, ...cmd };
          draft.commands = [...draft.commands, next].slice(-INJECT_QUEUE_MAX);
        });
      },
    }),
  });
  ctx.rpc.register(midiInject as Parameters<typeof ctx.rpc.register>[0]);
};

// ─────────────────────────────────────────────────────────────────────────
// Plugin factory
// ─────────────────────────────────────────────────────────────────────────

/**
 * Construct the Vite plugin instance — the resolve / compile / WASM-emit pipeline
 * plus the Vite-only dev-server features (HMR, COOP/COEP headers, the WASM
 * middleware, the DevTools bridge, and witness generation). `unworklet()` wraps it
 * through unplugin (below) for the public entry.
 *
 * Phase 5-E status (build mode):
 * - `name` declared
 * - `resolveId` translates `?worklet` imports into `\0unworklet:<abs>` virtual ids
 * - `load` evaluates the source module via Node native TS import, picks the
 *   `defineProcessor(...)` export, runs `compile()` on it, emits the WASM as
 *   a build asset via `this.emitFile`, and (when `emitAnalysisArtifacts` is
 *   enabled = default) also emits 4 sibling metadata JSON files
 *   (`<processor>.graph.json` / `.memory.json` / `.diagnostics.json` /
 *   `.schema-hash.json`) per `07-unplugin.md` §6.3. The hook's return
 *   value is a JS module that defers the WASM URL through Rolldown's
 *   `import.meta.ROLLUP_FILE_URL_<refId>`.
 * - Dev-mode middleware path (= ad-hoc WASM serve for `?worklet` requests in
 *   `vp dev`) is filled in a follow-up sub-step.
 */
function buildVitePlugin(options?: UnworkletPluginOptions): Plugin {
  const emitAnalysisArtifacts = options?.emitAnalysisArtifacts ?? true;
  const crossOriginIsolation = options?.crossOriginIsolation ?? true;
  const uiRoot = resolveDevtoolsUiRoot();
  let isServe = false;
  let devtoolsActive = false;
  let basePath = "/";
  let projectRoot = "";
  // The page's effective COEP (captured from the resolved config), mirrored onto
  // the DevTools panel iframe so a cross-origin-isolated app can embed it.
  let pageCoep: string | undefined;
  // Every `?worklet`-imported processor's compiled namespace, accumulated as
  // `load` evaluates each one. The aggregate witness `.d.ts` re-emits with the
  // full set on every (re)load — the typed `node.params` surface, no per-file
  // reference needed (mirrors Nuxt's `.nuxt/` codegen + Prisma's generate).
  const workletWitness = new Map<string, WorkletNamespace>();
  let witnessWarned = false;
  const writeWorkletsWitness = async (): Promise<void> => {
    // Only write into an existing project root. A non-existent root means a
    // synthetic config (e.g. a unit test passing a placeholder path), and the
    // recursive mkdir would otherwise materialise that fake tree on disk.
    if (!projectRoot || !existsSync(projectRoot)) return;
    try {
      const outDir = path.join(projectRoot, ".unworklet");
      await mkdir(outDir, { recursive: true });
      const entries = [...workletWitness].map(([source, ns]) => ({ source, ns }));
      const next = workletsDts(entries);
      // Write ONLY when the content actually changed. The dev server re-runs every
      // `?worklet` load on each page load, which calls this — rewriting an unchanged
      // file churns its mtime, Vite's watcher fires, and the cycle never settles.
      // The fixed `tsconfig.json` is intentionally NOT written here: it is seeded
      // once by `seedUnworkletDir` (before the watcher starts). Vite watches tsconfig
      // files and a rewrite forces a cache-clearing full reload, so re-emitting it on
      // every load would loop the dev server forever.
      const witnessPath = path.join(outDir, "worklets.d.ts");
      const current = existsSync(witnessPath) ? await readFile(witnessPath, "utf8") : null;
      if (current !== next) await writeFile(witnessPath, next);
    } catch (err) {
      // Type generation is best-effort: the WASM still compiles and runs without
      // it (the wildcard `?worklet` type keeps resolving). Warn once so a real
      // permission / path problem is visible without flooding the dev log.
      if (witnessWarned) return;
      witnessWarned = true;
      const at = path.join(projectRoot, ".unworklet", "worklets.d.ts");
      console.warn(
        `[@unworklet/unplugin] could not write ${at} — node.params types are unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  // Source paths the plugin has accepted via `?worklet` resolveId. Only these
  // are eligible for dev-mode evaluation + `compile(...)`. Without this gate,
  // the middleware would happily evaluate any absolute path that base64url-
  // encodes into the URL = arbitrary local file import via a crafted dev-
  // server request.
  const allowedSources = new Set<string>();
  // Vite dev server reference for `ssrLoadModule` + transitive watch fan-out.
  // Captured during `configureServer` and consulted by the dev paths inside
  // `load` and the middleware = transitive helper-module edits flow through
  // Vite's module graph instead of Node's static ESM cache.
  let viteDevServer: ViteDevServerLike | null = null;
  // Dev cache of (sourcePath, revisionHash) → compile snapshot. Every
  // snapshot holds **all** the per-revision artifacts a single createNode
  // sequence needs (= wasm bytes + extracted meta + processorName) so the
  // moduleUrl's worklet entry load and the wasmUrl's middleware response
  // resolve to the **same** revision even if the author saves between the
  // two requests (= round-5 finding 2 + round-6 finding 2). Snapshots stay
  // in a small LRU-ish ring (= keep last 2 revisions) so an in-flight
  // createNode race completes even after a reload triggers a new revision.
  type CompileSnapshot = {
    hash: string;
    wasm: Uint8Array;
    meta: ReturnType<typeof extractWorkletMeta>;
    processorName: string;
  };
  const snapshotsBySource = new Map<string, CompileSnapshot[]>();
  const latestRevisionBySource = new Map<string, string>();
  const SNAPSHOT_RING_SIZE = 2;
  const recordSnapshot = (sourcePath: string, snap: CompileSnapshot): void => {
    let ring = snapshotsBySource.get(sourcePath);
    if (!ring) {
      ring = [];
      snapshotsBySource.set(sourcePath, ring);
    }
    // De-dupe by hash, push newest to the end, evict oldest beyond ring size.
    const existing = ring.findIndex((s) => s.hash === snap.hash);
    if (existing >= 0) ring.splice(existing, 1);
    ring.push(snap);
    while (ring.length > SNAPSHOT_RING_SIZE) ring.shift();
    latestRevisionBySource.set(sourcePath, snap.hash);
  };
  const findSnapshot = (sourcePath: string, hash: string): CompileSnapshot | undefined =>
    snapshotsBySource.get(sourcePath)?.find((s) => s.hash === hash);
  return {
    name: "@unworklet/unplugin",
    enforce: "pre",
    config(userConfig, env) {
      // Dev-only gate for the core registry / page bridge: a single statically-
      // replaced boolean — `true` in serve, `false` in build — so production
      // tree-shakes the devtools wiring and tests (no plugin) leave it undefined.
      const define = {
        __UNWORKLET_DEVTOOLS__: env.command === "serve" ? "true" : "false",
        // Debug-only audio-thread invariant monitor (Layer F): `true` in serve,
        // `false` in build so production tree-shakes every self-check call.
        __UNWORKLET_SELFCHECK__: env.command === "serve" ? "true" : "false",
      };
      if (!crossOriginIsolation) return { define };
      // `SharedArrayBuffer` needs a cross-origin-isolated page. `credentialless`
      // is the least-breaking isolation level (cross-origin subresources still
      // load, without credentials). Both the dev server and `vite preview` get the
      // headers, so SAB works the same when iterating and when checking the build;
      // production headers stay the app server's job. `mergeConfig` would let a
      // plugin override the app's config, so set only the headers the app left
      // unset and never clobber an app's own COOP/COEP.
      const appHeaders =
        (userConfig as { server?: { headers?: Record<string, string> } }).server?.headers ?? {};
      const headers: Record<string, string> = {};
      if (!("Cross-Origin-Opener-Policy" in appHeaders)) {
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
      }
      if (!("Cross-Origin-Embedder-Policy" in appHeaders)) {
        headers["Cross-Origin-Embedder-Policy"] = "credentialless";
      }
      return Object.keys(headers).length > 0
        ? { define, server: { headers }, preview: { headers } }
        : { define };
    },
    configResolved(config) {
      isServe = config.command === "serve";
      projectRoot = config.root;
      // Seed `.unworklet/` SYNCHRONOUSLY here so the consumer's `extends` target
      // exists before Vite/Rolldown reads the tsconfig at build start (an async
      // write loses that race — the first build would fail with "Tsconfig not
      // found"). The async pass then fills the witness with the real per-processor
      // types as each `?worklet` loads.
      seedUnworkletDir(projectRoot);
      void writeWorkletsWitness();
      // Dev internal URLs (= `/@id/...`, `/__unworklet/...`) must be
      // request-path absolute so the middleware's `startsWith(...)` match
      // works. Vite documents `base` may be `'./'` / `''` (= relative,
      // for embedded deployment); in that case the dev server still serves
      // from the absolute origin root, so we fall back to `'/'` for
      // building internal URLs. Absolute bases (= `'/'` / `'/sub/'`) are
      // preserved so sub-path deployments under a dev server also work.
      if (config.base.startsWith("/")) {
        basePath = config.base.endsWith("/") ? config.base : `${config.base}/`;
      } else {
        basePath = "/";
      }
      // The resolved `server.headers` already merge the app's COOP/COEP with the
      // ones this plugin's `config` hook injected, so this is the single source of
      // truth for the page's effective COEP. The DevTools panel iframe mirrors it
      // (see `configureServer`); undefined here means the page is not isolated and
      // the panel needs no COEP.
      const resolvedHeaders =
        (config as { server?: { headers?: Record<string, string> } }).server?.headers ?? {};
      pageCoep = resolvedHeaders["Cross-Origin-Embedder-Policy"];
    },
    transformIndexHtml() {
      if (!isServe || !devtoolsActive) return;
      // Dev page bridge (zero-config, serve-only): expose the live-node registry
      // + snapshot codec on the page so the DevTools panel — and chrome-devtools
      // verification — can X-ray each node's linear memory. No application code
      // is involved; the plugin injects this automatically.
      // Inject by `src` to a virtual module (`\0` → `__x00__` is Vite's URL
      // encoding for virtual ids) so Vite resolves the bridge's bare imports
      // through the normal pipeline.
      return [
        {
          tag: "script",
          attrs: {
            type: "module",
            src: `${basePath}@id/__x00__${DEVBRIDGE_ID.slice(1)}`,
          },
          injectTo: "head",
        },
      ];
    },
    configureServer(server) {
      viteDevServer = server as unknown as ViteDevServerLike;
      // DevTools panel iframe COEP (serve-only). The `@vitejs/devtools` host serves
      // the panel SPA as a static iframe at `/__unworklet/`, and its static
      // middleware sets only content headers — never COEP. A cross-origin-isolated
      // page (= the default, so `SharedArrayBuffer` works) blocks every embedded
      // iframe that lacks its own COEP header, so the panel "refused to connect".
      // Mirror the page's COEP onto the panel responses so the iframe is embeddable
      // while the page stays isolated. This plugin is `enforce: "pre"` and the
      // devtools host is `enforce: "post"`, so this middleware is registered — and
      // runs — before the host's static serve: the header set here is still on the
      // response when the host pipes the file. Skipped when the page has no COEP.
      const coep = pageCoep;
      if (coep) {
        server.middlewares.use((req, res, next) => {
          const pathOnly = req.url?.split("?", 1)[0];
          if (pathOnly?.startsWith("/__unworklet/")) {
            res.setHeader("Cross-Origin-Embedder-Policy", coep);
          }
          next();
        });
      }
      // Dev-mode middleware = serve compiled WASM bytes at a hash-pinned URL.
      // The worklet entry JS is **not** served here — it goes through
      // Vite's module pipeline (= `\0unworklet-worklet:` virtual id under
      // `/@id/`) so Vite's resolver + transform can rewrite the bare
      // `@unworklet/core/worklet` import to a browser-safe URL. Serving
      // a raw template from custom middleware skips Vite's transform step
      // entirely and the worklet realm would crash on the bare specifier.
      //
      // The URL carries a revision hash so a save between
      // `audioWorklet.addModule(moduleUrl)` and `fetch(wasmUrl)` cannot
      // pair stale inline meta with new WASM bytes — both URLs minted
      // inside a single `createNode` call share the same revision token.
      const devUrlBase = `${basePath}${DEV_URL_PREFIX}/`;
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const queryIdx = req.url.indexOf("?");
        const pathOnly = queryIdx < 0 ? req.url : req.url.slice(0, queryIdx);
        if (!pathOnly.startsWith(devUrlBase)) return next();
        const rest = pathOnly.slice(devUrlBase.length);
        // Expect `<encoded>/<hash>/wasm`. Any other shape is not ours.
        const segments = rest.split("/");
        if (segments.length !== 3) return next();
        const [encoded, hash, part] = segments as [string, string, string];
        if (part !== "wasm") return next();
        if (!/^[0-9a-f]{8}$/.test(hash)) return next();
        const sourcePath = (() => {
          try {
            return decodeSourceFromDevUrl(encoded);
          } catch {
            return null;
          }
        })();
        if (!sourcePath) return next();
        // Allowlist gate = only paths the plugin itself accepted via
        // `?worklet` resolveId may be served by the middleware.
        if (!allowedSources.has(sourcePath)) return next();

        (async (): Promise<void> => {
          // Prefer the in-memory snapshot for the requested revision so a
          // race between save + outstanding fetch resolves to the matching
          // WASM bytes (= no skew with the moduleUrl's inlined meta). If
          // the requested revision rolled out of the ring, fall through to
          // a fresh compile (last-resort = strict newer-than-cache request).
          let bytes: Uint8Array | undefined = findSnapshot(sourcePath, hash)?.wasm;
          if (!bytes) {
            // The middleware was registered via `configureServer`, which
            // captured `viteDevServer` in the same call. By the time a
            // request reaches here it is guaranteed non-null = assert
            // rather than carry a dead `importFresh` fallback branch
            // that the dev path can never reach.
            const sourceModule = await ssrLoadSource(viteDevServer!, sourcePath);
            const { exportName, processor } = pickCompiledProcessor(sourceModule, sourcePath);
            const result = await compile(processor);
            const freshHash = computeRevisionHash(result.wasm);
            const freshMeta = extractWorkletMeta(
              processor.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
            );
            recordSnapshot(sourcePath, {
              hash: freshHash,
              wasm: result.wasm,
              meta: freshMeta,
              processorName: computeProcessorName(exportName, sourcePath, result.wasm),
            });
            if (freshHash !== hash) {
              // Revision the client asked for is gone; signal a hard
              // failure instead of silently serving a different binary.
              res.statusCode = 410;
              res.end(`unworklet: revision ${hash} no longer available (now ${freshHash})`);
              return;
            }
            bytes = result.wasm;
          }
          res.setHeader("Content-Type", "application/wasm");
          res.setHeader("Cache-Control", "no-cache");
          res.end(Buffer.from(bytes));
        })().catch((err: unknown) => {
          console.error("[@unworklet/unplugin] middleware error:", err);
          res.statusCode = 500;
          res.end(String(err));
        });
      });
    },
    transform(code, id) {
      // Lower a `.uwk.ts` sugar source to plain core `.ts` before any downstream
      // loader / bundler evaluates it. `enforce: "pre"` runs this ahead of Vite's
      // own TS→JS transform, and it covers every Vite-pipeline evaluation of the
      // source at once: dev `ssrLoadModule`, the dev WASM middleware, and the
      // consumer-bundle re-import emitted by `load`. (The build path's raw Node
      // `import()` does not run transforms — `loadProcessorModuleFresh` lowers
      // there.) The `?worklet` / `?t=` / `?v=` query suffix is stripped first.
      //
      // Skip the plugin's OWN virtual modules: their id is `\0unworklet:<source>`
      // (Vite's `\0` virtual-module convention), so it ends in the source path —
      // possibly `.uwk.ts` — but the code is the already-generated augmented JS,
      // not raw sugar. Lowering it would throw `uwk-no-process`.
      if (id.startsWith("\0")) return undefined;
      const queryIdx = id.indexOf("?");
      const filePath = queryIdx < 0 ? id : id.slice(0, queryIdx);
      if (!isUwkSource(filePath)) return undefined;
      try {
        return { code: lowerUwkSource(filePath, code), map: null };
      } catch (err) {
        // Surface a LowerError (or any lowering failure) as a Vite diagnostic
        // anchored at the source rather than crashing the dev server / build.
        this.error(err instanceof Error ? err.message : String(err));
      }
    },
    resolveId(source, importer) {
      if (source === DEVBRIDGE_ID) return source;
      if (source.startsWith(WORKLET_ENTRY_PREFIX)) return source;
      const detect = detectWorkletQuery(source);
      if (!detect) return undefined;
      const resolved = resolveAgainstImporter(detect.basePath, importer);
      if (!resolved) return undefined;
      allowedSources.add(resolved);
      return `${VIRTUAL_ID_PREFIX}${resolved}`;
    },
    async load(id) {
      if (id === DEVBRIDGE_ID) {
        // The DevTools page bridge, served as a real module so Vite rewrites its
        // bare imports. Dev-only + injected by the plugin (the app writes no
        // devtools code). It (1) exposes the live-node registry + snapshot codec
        // for later live-state X-ray, and (2) captures the live audio-graph
        // topology by monkey-patching AudioNode.connect/disconnect, then pushes
        // it to the server via the `unworklet:graph-update` action RPC. No WASM
        // memory is read here — this is Web-Audio graph structure only.
        return `
import { getDevNodes, onDevNodesChanged } from "@unworklet/core/dev";
import { decodeScalar, decodeTypedArray } from "@unworklet/core";
import { appendBounded, downsampleTo, drainInjects, foldProxyGraph, frameLevels, normalizeFreqDb, slotMemory, splitSlots } from "@unworklet/unplugin/devbridge";
import { getDevToolsClientContext } from "@vitejs/devtools-kit/client";

globalThis.__unworklet_getDevNodes = getDevNodes;
globalThis.__unworklet_decodeScalar = decodeScalar;
globalThis.__unworklet_decodeTypedArray = decodeTypedArray;

const ids = new WeakMap();
let seq = 0;
const seen = new Set();
const edges = new Map();
const idOf = (n) => {
  let id = ids.get(n);
  if (id === undefined) { id = "n" + seq++; ids.set(n, id); seen.add(n); }
  return id;
};

const buildGraph = () => {
  // Extract plain graph data (ids + labels + the proxy-owner map) from the live
  // AudioNodes, then let foldProxyGraph (unit-tested) splice the internal input
  // proxies out so the graph shows exactly the connections the app wrote.
  const uw = new Map();        // AudioWorkletNode -> { label, inputs, outputs }
  const proxyOwner = {};       // proxyGainId -> owning unworklet node id
  const liveIds = new Set();   // node ids that should remain in the graph
  for (const h of getDevNodes()) {
    const awn = h.node.node;
    const ins = h.node.inputs || {};
    uw.set(awn, {
      label: h.displayName || h.processorName,
      inputs: Object.keys(ins),
      outputs: Object.keys(h.node.outputs || {}),
    });
    const ownerId = idOf(awn);
    liveIds.add(ownerId);
    for (const k in ins) { const g = ins[k]; if (g) { proxyOwner[idOf(g)] = ownerId; liveIds.add(idOf(g)); } }
  }
  // A node stays in the graph only while it is a live unworklet node, one of its
  // input proxies, or an endpoint of a current edge. Anything else (a disposed
  // node, a disconnected standard node) is dropped — and freed from the seen/ids
  // maps so the capture doesn't leak every AudioNode for the page's lifetime.
  for (const e of edges.values()) { liveIds.add(e.from); liveIds.add(e.to); }
  const rawNodes = [];
  for (const n of [...seen]) {
    const id = idOf(n);
    if (!liveIds.has(id)) { seen.delete(n); ids.delete(n); continue; }
    const meta = uw.get(n);
    const type = (n.constructor && n.constructor.name) || "AudioNode";
    if (meta) {
      rawNodes.push({ id, label: meta.label, kind: "unworklet", audioNodeType: type, inputs: meta.inputs, outputs: meta.outputs });
    } else {
      rawNodes.push({ id, label: type, kind: "standard", audioNodeType: type });
    }
  }
  return foldProxyGraph(rawNodes, [...edges.values()], proxyOwner);
};

let client = null;
// Fire an RPC and swallow both a synchronous throw and an async rejection — a
// transient backend hiccup (or a second dev server stealing trust) must never
// surface as an unhandled promise rejection in the app's console.
const rpcCall = (name, arg) => {
  if (!client) return;
  try {
    const r = client.rpc.call(name, arg);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (e) { /* dev only */ }
};
let pending = false;
const push = () => {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    rpcCall("devframe:anonymous:unworklet:graph-update", buildGraph());
  });
};

let polls = 0;
const ensureClient = () => {
  if (client) return;
  client = getDevToolsClientContext() || null;
  if (client) { push(); startStatePoll(); startSignalsPoll(); startMidiPoll(); return; }
  if (polls++ < 40) setTimeout(ensureClient, 100);
};

// Live state X-ray: poll each node's devDump on a gentle cadence, decode every
// slot, and push it to the server. Scalars carry their decoded value (i64 as a
// decimal string — JSON has no bigint); buffers carry their decoded elements,
// stride-downsampled to BUFFER_MAX_POINTS when large (the worklet already copied
// the full bytes — this only keeps the wire light, the audio thread is untouched).
const STATE_POLL_MS = 200;
const BUFFER_MAX_POINTS = 512;
let statePolling = false;
const pollState = async () => {
  if (statePolling || !client) return;
  statePolling = true;
  try {
    const nodes = [];
    for (const h of getDevNodes()) {
      let slots;
      try { slots = await h.devDump(); } catch (e) { slots = []; }
      // splitSlots (unit-tested) decodes scalars + downsamples buffers.
      const { scalars, buffers } = splitSlots(slots, BUFFER_MAX_POINTS);
      nodes.push({ id: idOf(h.node.node), displayName: h.displayName || h.processorName, scalars, buffers });
    }
    rpcCall("devframe:anonymous:unworklet:state-update", { nodes });
  } finally {
    statePolling = false;
  }
};
let stateTimer = null;
const startStatePoll = () => {
  if (stateTimer !== null) return;
  const loop = async () => {
    await pollState();
    stateTimer = setTimeout(loop, STATE_POLL_MS);
  };
  stateTimer = setTimeout(loop, STATE_POLL_MS);
};

// Signals X-ray: tap an AnalyserNode on every unworklet output port and stream
// the live scope (time domain) + spectrum (frequency domain) + levels to the
// server. The analyser is a fan-out branch — it observes the signal without
// altering what reaches the speakers. Memory is a static one-shot devDump.
const SIGNALS_POLL_MS = 33;
const SCOPE_POINTS = 256;
const SPECTRUM_POINTS = 128;
const analysersByNode = new WeakMap();
const memoryByNode = new Map();
const ensureAnalysers = (awn, outputs) => {
  let map = analysersByNode.get(awn);
  if (map) return map;
  map = new Map();
  const actx = awn.context;
  const names = Object.keys(outputs || {});
  const count = awn.numberOfOutputs || 0;
  for (let i = 0; i < count; i++) {
    const name = names[i] || ("out" + i);
    try {
      const analyser = actx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;
      // Connect through the ORIGINAL connect so the AudioNode.connect patch
      // below doesn't capture this devtools-owned tap as an application edge
      // (it would otherwise add a phantom AnalyserNode to the Audio Graph).
      realConnect.call(awn, analyser, i, 0);
      map.set(name, { analyser, index: i, time: new Float32Array(analyser.fftSize), freq: new Float32Array(analyser.frequencyBinCount) });
    } catch (e) { /* dev only: a node may reject the extra fan-out, skip it */ }
  }
  analysersByNode.set(awn, map);
  return map;
};
let signalsBusy = false;
const pollSignals = async () => {
  if (!client) return;
  const nodes = [];
  const liveIds = new Set();
  let actx = null;
  for (const h of getDevNodes()) {
    const awn = h.node.node;
    actx = awn.context;
    const id = idOf(awn);
    liveIds.add(id);
    const map = ensureAnalysers(awn, h.node.outputs);
    const ports = [];
    for (const [name, slot] of map) {
      slot.analyser.getFloatTimeDomainData(slot.time);
      slot.analyser.getFloatFrequencyData(slot.freq);
      const lv = frameLevels(slot.time);
      ports.push({ name, time: downsampleTo(slot.time, SCOPE_POINTS), freq: normalizeFreqDb(slot.freq, SPECTRUM_POINTS), rms: lv.rms, peak: lv.peak });
    }
    let mem = memoryByNode.get(id);
    if (!mem) {
      try { mem = slotMemory(await h.devDump()); memoryByNode.set(id, mem); }
      catch (e) { mem = { entries: [], totalBytes: 0 }; }
    }
    nodes.push({ id, displayName: h.displayName || h.processorName, ports, memory: mem.entries, memoryBytes: mem.totalBytes });
  }
  // Drop cached memory layouts for nodes no longer live so this strong map does
  // not retain an entry per disposed node for the page's lifetime as ids climb
  // across processor recreation (mirrors the frame reconcile in useLiveSignals).
  for (const k of memoryByNode.keys()) if (!liveIds.has(k)) memoryByNode.delete(k);
  const context = actx
    ? { sampleRate: actx.sampleRate || 0, baseLatencyMs: (actx.baseLatency || 0) * 1000, outputLatencyMs: (actx.outputLatency || 0) * 1000 }
    : { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 };
  rpcCall("devframe:anonymous:unworklet:signals-update", { nodes, context });
};
let signalsTimer = null;
const startSignalsPoll = () => {
  if (signalsTimer !== null) return;
  const loop = async () => {
    if (!signalsBusy) { signalsBusy = true; try { await pollSignals(); } finally { signalsBusy = false; } }
    signalsTimer = setTimeout(loop, SIGNALS_POLL_MS);
  };
  signalsTimer = setTimeout(loop, SIGNALS_POLL_MS);
};

// MIDI X-ray: tap onEvent on every outbound port for the live log, read each
// port's real overflow counter, and drain a server-seq'd inject queue into
// node.midi[port].send so the virtual keyboard plays the real worklet.
const MIDI_TYPES = ["noteOn", "noteOff", "cc", "pitchBend", "programChange", "channelPressure", "aftertouch", "systemRealtime", "sysex"];
const MIDI_LOG_MAX = 200;
const MIDI_POLL_MS = 150;
let midiLog = [];
let midiSeq = 0;
let lastMidiSig = "";
const midiTapped = new WeakSet();
let lastInjectSeq = 0;
let midiInjectSubscribed = false;
const eventToJson = (e) => (e && e.type === "sysex" && e.data ? { type: "sysex", data: Array.from(e.data) } : e);
const tapMidiOut = (h) => {
  const awn = h.node.node;
  if (midiTapped.has(awn)) return;
  midiTapped.add(awn);
  const id = idOf(awn);
  const midi = h.node.midi || {};
  for (const pm of h.midiPorts || []) {
    if (pm.direction !== "out") continue;
    const port = midi[pm.name];
    if (!port || typeof port.onEvent !== "function") continue;
    for (const t of MIDI_TYPES) {
      try {
        port.onEvent(t, (e) => {
          midiLog = appendBounded(midiLog, { seq: ++midiSeq, ts: Date.now(), dir: "out", nodeId: id, port: pm.name, event: eventToJson(e) }, MIDI_LOG_MAX);
        });
      } catch (err) { /* dev only */ }
    }
  }
};
const findHandleById = (id) => {
  for (const h of getDevNodes()) { if (idOf(h.node.node) === id) return h; }
  return null;
};
const ensureMidiInjectSub = () => {
  if (midiInjectSubscribed || !client || !client.rpc || !client.rpc.sharedState) return;
  midiInjectSubscribed = true;
  client.rpc.sharedState.get("unworklet:midi-inject").then((shared) => {
    const onInject = (state) => {
      const cmds = (state && state.commands) || [];
      const drained = drainInjects(cmds, lastInjectSeq);
      lastInjectSeq = drained.lastSeq;
      for (const c of drained.fresh) {
        const h = findHandleById(c.nodeId);
        if (!h) continue;
        const port = (h.node.midi || {})[c.port];
        if (!port || typeof port.send !== "function") continue;
        try {
          port.send(c.event);
          midiLog = appendBounded(midiLog, { seq: ++midiSeq, ts: Date.now(), dir: "inject", nodeId: c.nodeId, port: c.port, event: c.event }, MIDI_LOG_MAX);
        } catch (err) { /* dev only */ }
      }
    };
    onInject(shared.value());
    shared.on("updated", onInject);
  }).catch(() => { midiInjectSubscribed = false; });
};
const pollMidi = () => {
  if (!client) return;
  ensureMidiInjectSub();
  const ports = [];
  for (const h of getDevNodes()) {
    tapMidiOut(h);
    const id = idOf(h.node.node);
    const midi = h.node.midi || {};
    for (const pm of h.midiPorts || []) {
      let overflow = 0;
      try { const p = midi[pm.name]; if (p && p.diagnostics) overflow = p.diagnostics.overflowCount() || 0; } catch (e) { /* dev only */ }
      ports.push({ nodeId: id, node: h.displayName || h.processorName, name: pm.name, direction: pm.direction, overflow });
    }
  }
  // Only push when ports / overflow / log actually changed — avoids re-rendering
  // the panel every poll while the app is idle (no MIDI traffic).
  const sig = JSON.stringify({ ports, log: midiLog });
  if (sig === lastMidiSig) return;
  lastMidiSig = sig;
  rpcCall("devframe:anonymous:unworklet:midi-update", { ports, log: midiLog });
};
let midiTimer = null;
const startMidiPoll = () => {
  if (midiTimer !== null) return;
  const loop = () => { pollMidi(); midiTimer = setTimeout(loop, MIDI_POLL_MS); };
  midiTimer = setTimeout(loop, MIDI_POLL_MS);
};

const AN = AudioNode.prototype;
const realConnect = AN.connect;
const realDisconnect = AN.disconnect;
AN.connect = function (target) {
  const r = realConnect.apply(this, arguments);
  if (target instanceof AudioNode) {
    const from = idOf(this), to = idOf(target);
    // Track the source output AND destination input so disconnect overloads drop
    // exactly the right edges. The graph id stays from>to (foldProxyGraph dedups
    // on it); the map key carries out:in so parallel connections coexist.
    const out = (typeof arguments[1] === "number") ? arguments[1] : 0;
    const inp = (typeof arguments[2] === "number") ? arguments[2] : 0;
    edges.set(from + ">" + to + "#" + out + ":" + inp, { id: from + ">" + to, from, to, out, in: inp });
    push();
  }
  return r;
};
// Re-attach a node's DevTools analyser tap(s) after the app's own disconnect
// severs them — a tap shares the node's output, so disconnect() / disconnect(output)
// cut it too, and ensureAnalysers() returns the cached (now-detached) analyser.
// Without this the Signals panel would poll a dead analyser and show stale data.
const isLiveDevNode = (node) => {
  for (const h of getDevNodes()) if (h.node && h.node.node === node) return true;
  return false;
};
const reattachTaps = (node, outputIndex) => {
  const map = analysersByNode.get(node);
  if (!map) return;
  // A zero-arg disconnect during dispose() (the handle is unregistered first)
  // must NOT re-wire taps onto a dead node — drop them so disposed nodes don't
  // accumulate detached analyser subgraphs across play/stop cycles.
  if (outputIndex === null && !isLiveDevNode(node)) { analysersByNode.delete(node); return; }
  for (const slot of map.values()) {
    if (outputIndex !== null && slot.index !== outputIndex) continue;
    try { realConnect.call(node, slot.analyser, slot.index, 0); } catch (e) { /* dev only */ }
  }
};
AN.disconnect = function (target) {
  const r = realDisconnect.apply(this, arguments);
  const from = idOf(this);
  // Mirror every AudioNode.disconnect overload so the captured graph never keeps
  // an edge the real graph dropped.
  const removeWhere = (pred) => {
    for (const [k, e] of [...edges]) if (e.from === from && pred(e)) edges.delete(k);
  };
  if (arguments.length === 0) { removeWhere(() => true); reattachTaps(this, null); }
  else if (typeof target === "number") { removeWhere((e) => e.out === target); reattachTaps(this, target); }
  else if (target instanceof AudioNode) {
    const to = idOf(target);
    const out = (typeof arguments[1] === "number") ? arguments[1] : null;
    const inp = (typeof arguments[2] === "number") ? arguments[2] : null;
    removeWhere((e) => e.to === to && (out === null || e.out === out) && (inp === null || e.in === inp));
    // disconnect(destinationNode, ...) targets the destination, never the tap.
  }
  push();
  return r;
};

onDevNodesChanged(push);
ensureClient();
`;
      }
      if (id.startsWith(WORKLET_ENTRY_PREFIX)) {
        // The id can arrive with a `?v=<hash>` revision query in dev (=
        // Vite passes the full request id including query into `load`).
        // The query is the only way to look the right per-revision snapshot
        // up — drop the prefix, split off the query, keep going.
        const idAfterPrefix = id.slice(WORKLET_ENTRY_PREFIX.length);
        const queryIdx = idAfterPrefix.indexOf("?");
        const sourcePath = queryIdx < 0 ? idAfterPrefix : idAfterPrefix.slice(0, queryIdx);
        const query = queryIdx < 0 ? "" : idAfterPrefix.slice(queryIdx + 1);
        this.addWatchFile(sourcePath);

        if (isServe) {
          // Dev path = strictly snapshot-driven. Trust boundary: only
          // sourcePaths the plugin itself accepted via `?worklet`
          // `resolveId` may be evaluated. Vite exposes virtual ids as
          // `/@id/__x00__<rest>` so an unaudited client could otherwise
          // craft a request for any local file (= round-6 finding 1).
          if (!allowedSources.has(sourcePath)) {
            return null;
          }
          const params = new URLSearchParams(query);
          const requestedHash = params.get("v") ?? "";
          if (!/^[0-9a-f]{8}$/.test(requestedHash)) {
            return null;
          }
          const snap = findSnapshot(sourcePath, requestedHash);
          if (!snap) {
            // Revision rolled out of the ring. Refuse to silently emit a
            // template against a different revision (= would pair stale
            // meta with new WASM the same way round-5 was meant to close).
            // Returning `null` makes Vite respond 404, surfacing the skew
            // as a clean addModule() rejection on the consumer side.
            return null;
          }
          return emitWorkletTemplate({
            processorName: snap.processorName,
            meta: snap.meta,
          });
        }

        // Build path: rolldown emits the chunk via `this.emitFile`, snapshot
        // ring not involved. Recompile + recompute the processorName from
        // the WASM bytes so dev and build produce the same registration name
        // for a given source / revision pair.
        const sourceModule = await loadProcessorModuleFresh(sourcePath);
        const { exportName, processor } = pickCompiledProcessor(sourceModule, sourcePath);
        const buildResult = await compile(processor);
        const meta = extractWorkletMeta(
          processor.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
        );
        return emitWorkletTemplate({
          processorName: computeProcessorName(exportName, sourcePath, buildResult.wasm),
          meta,
        });
      }

      if (!id.startsWith(VIRTUAL_ID_PREFIX)) return undefined;
      const sourcePath = id.slice(VIRTUAL_ID_PREFIX.length);
      // Declare the virtual module's dependency on the source so vite invalidates
      // it when the file changes (= full-page reload picks up edits without
      // restarting the dev server).
      this.addWatchFile(sourcePath);
      const sourceModule =
        isServe && viteDevServer
          ? await ssrLoadSource(viteDevServer, sourcePath)
          : await loadProcessorModuleFresh(sourcePath);
      // Dev mode: fan watch dependencies out across every transitive file
      // reachable from the processor source = a helper edit invalidates this
      // virtual module just like editing the entry would (= 07-unplugin.md
      // §3 dev/build symmetry).
      if (isServe && viteDevServer) {
        for (const dep of collectTransitiveDeps(viteDevServer, sourcePath)) {
          this.addWatchFile(dep);
        }
      }
      const { exportName, processor } = pickCompiledProcessor(sourceModule, sourcePath);

      // Record this processor's compiled namespace and (re-)emit the aggregate
      // witness so the consumer's `node.params.<name>` (and friends) is typed.
      workletWitness.set(sourcePath, processor.worklet);
      await writeWorkletsWitness();

      const baseName = assetBaseName(sourcePath);

      let moduleUrlExpr: string;
      let wasmUrlExpr: string;
      let processorName: string;
      let bakedSampleRate: number;

      if (isServe) {
        // Dev: compile up front so we can mint a revision token + cache the
        // snapshot. Both URLs carry the hash = `addModule(moduleUrl)` and
        // `fetch(wasmUrl)` inside a single `createNode()` always resolve to
        // the same compile snapshot, even if the author saves between the
        // two requests (= no inline-meta vs WASM byte skew).
        //
        // The worklet entry URL goes through Vite's `/@id/` virtual-module
        // route (= `__x00__` is vite's URL-safe encoding of the `\0` prefix
        // that marks virtual ids), so Vite's transform pipeline can resolve
        // the bare `@unworklet/core/worklet` import inside the emitted
        // template. Raw middleware output would skip that step and the
        // worklet realm would choke on the bare specifier.
        const result = await compile(processor);
        const hash = computeRevisionHash(result.wasm);
        const devMeta = extractWorkletMeta(
          processor.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
        );
        const devProcessorName = computeProcessorName(exportName, sourcePath, result.wasm);
        // Snapshot the full per-revision bundle = wasm + meta + processorName.
        // The worklet-entry virtual load and the wasm middleware both look
        // their per-request hash up here; both find the same artifacts or
        // both 410, so no path through createNode can pair a stale meta
        // with new bytes (= round-6 finding 2).
        recordSnapshot(sourcePath, {
          hash,
          wasm: result.wasm,
          meta: devMeta,
          processorName: devProcessorName,
        });

        const encoded = encodeSourceForDevUrl(sourcePath);
        const virtualWorkletId = `${WORKLET_ENTRY_PREFIX}${sourcePath}`;
        // `\0` → `__x00__` is Vite's standard URL encoding for virtual ids
        // (the dev server decodes it back into the null-byte prefix that
        // resolveId / load hooks see).
        const virtualWorkletUrlPath = `${basePath}@id/__x00__${virtualWorkletId.slice(1)}`;
        moduleUrlExpr = JSON.stringify(`${virtualWorkletUrlPath}?v=${hash}`);
        wasmUrlExpr = JSON.stringify(`${basePath}${DEV_URL_PREFIX}/${encoded}/${hash}/wasm`);
        processorName = devProcessorName;
        bakedSampleRate = result.sampleRate;
      } else {
        // Build mode: emit chunk + asset via rolldown's `emitFile`. URLs are
        // resolved through `import.meta.ROLLUP_FILE_URL_<refId>` placeholders
        // which rolldown rewrites to `new URL(...)` at output time.
        const result = await compile(processor);
        const wasmRefId = this.emitFile({
          type: "asset",
          name: `${baseName}.wasm`,
          source: result.wasm,
        });
        const workletRefId = this.emitFile({
          type: "chunk",
          id: `${WORKLET_ENTRY_PREFIX}${sourcePath}`,
          name: `${baseName}.worklet`,
        });
        moduleUrlExpr = `import.meta.ROLLUP_FILE_URL_${workletRefId}`;
        wasmUrlExpr = `import.meta.ROLLUP_FILE_URL_${wasmRefId}`;
        processorName = computeProcessorName(exportName, sourcePath, result.wasm);
        bakedSampleRate = result.sampleRate;

        if (emitAnalysisArtifacts) {
          this.emitFile({
            type: "asset",
            name: `${baseName}.graph.json`,
            source: `${JSON.stringify(result.graph, bigintReplacer, 2)}\n`,
          });
          this.emitFile({
            type: "asset",
            name: `${baseName}.memory.json`,
            source: `${JSON.stringify(result.memory, bigintReplacer, 2)}\n`,
          });
          this.emitFile({
            type: "asset",
            name: `${baseName}.diagnostics.json`,
            source: `${JSON.stringify(result.diagnostics, bigintReplacer, 2)}\n`,
          });
          this.emitFile({
            type: "asset",
            name: `${baseName}.schema-hash.json`,
            source: `${JSON.stringify({ schemaHash: result.schemaHash }, bigintReplacer, 2)}\n`,
          });
        }
      }

      // virtual module = re-import the user source to recover the
      // CompiledProcessor, then export a form whose worklet namespace carries
      // the bundler URLs (moduleUrl / wasmUrl / processorName). The function
      // entries (initialize / process / parameterDescriptors) are inherited
      // from the original namespace via spread. `processorName` was already
      // computed with the WASM revision hash folded in (in each of the dev /
      // build branches), so different revisions of the same source never
      // collide on `registerProcessor`.
      return [
        `import { ${exportName} as __unworkletRaw } from ${JSON.stringify(sourcePath)};`,
        ``,
        `const __unworkletAugmented = {`,
        `  ...__unworkletRaw,`,
        `  worklet: {`,
        `    ...__unworkletRaw.worklet,`,
        `    moduleUrl: ${moduleUrlExpr},`,
        `    wasmUrl: ${wasmUrlExpr},`,
        `    processorName: ${JSON.stringify(processorName)},`,
        `    displayName: ${JSON.stringify(exportName)},`,
        `    bakedSampleRate: ${bakedSampleRate},`,
        `  },`,
        `};`,
        ``,
        `export default __unworkletAugmented;`,
        `export { __unworkletAugmented as ${exportName} };`,
        ``,
      ].join("\n");
    },
    async handleHotUpdate(ctx) {
      // A processor source edit must re-run the `?worklet` virtual module's
      // `load` (= recompile). `addWatchFile` alone does not invalidate the
      // virtual module here, so Vite serves the cached transform and edits are
      // not reflected until the dev server restarts. Explicitly invalidate the
      // virtual module and steer the HMR update to it: its importer's
      // `import.meta.hot.accept('...?worklet', ...)` then receives a freshly
      // compiled processor (= live-coding via `replaceProcessor`, `07-unplugin.md` §4).
      //
      // Which processor(s) does this edit affect? A processor edit affects itself;
      // a helper / subgraph edit (a `.uwk.ts` imported by a processor) affects every
      // processor whose transitive deps include it — so editing a subgraph file
      // recompiles the processors that instantiate it, not just the entry.
      const server = viteDevServer;
      const affected = allowedSources.has(ctx.file)
        ? [ctx.file]
        : isServe && server
          ? [...allowedSources].filter((p) => collectTransitiveDeps(server, p).has(ctx.file))
          : [];
      if (affected.length === 0) return;
      // Re-evaluate each affected processor and re-emit the witness so the editor's
      // file watch refreshes node.params completions even with no browser attached
      // to drive an HMR `load` (best-effort: a parse error mid-edit must not break HMR).
      for (const proc of affected) {
        try {
          const mod =
            isServe && server
              ? await ssrLoadSource(server, proc)
              : await loadProcessorModuleFresh(proc);
          workletWitness.set(proc, pickCompiledProcessor(mod, proc).processor.worklet);
        } catch {
          // keep the previous witness; the next successful edit refreshes it
        }
      }
      await writeWorkletsWitness();
      const mods = affected
        .map((proc) => ctx.server.moduleGraph.getModuleById(`${VIRTUAL_ID_PREFIX}${proc}`))
        .filter((m): m is NonNullable<typeof m> => m != null);
      for (const m of mods) ctx.server.moduleGraph.invalidateModule(m);
      return mods.length > 0 ? mods : undefined;
    },
    devtools: {
      setup: (ctx) => {
        // This hook fires only when the `@vitejs/devtools` host is present in the
        // config — which is exactly when `@vitejs/devtools-kit` is installed and
        // browser-resolvable. Gate the page-bridge injection on it so apps without
        // the DevTools panel (examples, test runners) never get the bridge's
        // `@vitejs/devtools-kit/client` import, which they cannot resolve.
        devtoolsActive = true;
        return setupDevtools(ctx, uiRoot);
      },
    },
  };
}

/**
 * unplugin wrapper. The plugin is authored against Vite's plugin context; routing
 * it through unplugin lets the package grow bundler-agnostic build entries
 * (webpack / rollup / esbuild) without a second implementation. For the `.vite()`
 * output unplugin keeps the plugin's native context untouched, so the produced
 * value is exactly what `buildVitePlugin` constructs. The dev-server features (HMR,
 * COOP/COEP, the WASM middleware, the DevTools bridge, witness generation) are
 * Vite-only by design and live under the `vite` key; lifting the portable
 * resolve/compile/emit hooks onto the universal surface is a later step (it needs a
 * per-bundler asset-emit strategy, since the build path relies on rolldown's
 * `emitFile` chunk + `import.meta.ROLLUP_FILE_URL_*`).
 */
const unworkletUnplugin = createUnplugin<UnworkletPluginOptions | undefined, false>((options) => ({
  name: "@unworklet/unplugin",
  enforce: "pre",
  // unplugin types its `vite` field against the real `vite` package's `Plugin`,
  // while this repo aliases `vite` → `@voidzero-dev/vite-plus-core`. The two `Plugin`
  // shapes are structurally identical but nominally distinct, so a direct assignment
  // overruns the structural-comparison depth; bridge the single boundary here. The
  // runtime value is exactly a Vite plugin (the hook tests exercise it).
  vite: buildVitePlugin(options) as unknown as UnpluginOptions["vite"],
}));

/**
 * The unworklet Vite plugin. Default export per Vite convention; also re-exported
 * as the named `unworkletPlugin` for explicit import.
 */
export default function unworklet(options?: UnworkletPluginOptions): Plugin {
  return unworkletUnplugin.vite(options) as unknown as Plugin;
}

export { unworklet as unworkletPlugin };
