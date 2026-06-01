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

/// <reference types="@vitejs/devtools-kit" />
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile, extractWorkletMeta } from "@unworklet/core";
import type { CompiledProcessor } from "@unworklet/core";
import type { Plugin } from "vite-plus";

import { emitWorkletTemplate } from "./worklet-template.ts";

/**
 * Suffix appended to the processor export name to derive the
 * `AudioWorkletProcessor` registration name。 AudioWorklet's
 * `registerProcessor(name, klass)` throws `NotSupportedError` on a
 * duplicate name within the same `BaseAudioContext.audioWorklet` AND has
 * no de-register API — once a name is taken inside a context, it is
 * taken forever for the lifetime of that context。
 *
 * Composition: `<exportName>__<srcHash8>__<revHash8>` where
 * - `srcHash8` = sha-8 of the absolute source path, separates two unrelated
 *   files that happen to share an export identifier (= e.g. both export
 *   `stereoGain` from different paths)。
 * - `revHash8` = sha-8 of the compiled WASM bytes (= revision identity)、
 *   so a new revision of the same source registers under a NEW name and
 *   can coexist with in-flight nodes from the previous revision until
 *   the consumer disposes them。 This is the only browser-API-compliant
 *   path for forward-compatible `?worklet` HMR / `replaceProcessor`
 *   wiring (= `07-vite-plugin.md` §4, Q50)。
 *
 * 8 hex chars per component = 32 bit。 Collision probability across the
 * cartesian product of (source path × revision) is negligible for any
 * realistic project / dev session (birthday bound ~65k pairs for 1%)。
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
 * cached evaluation from the first `import()`。
 *
 * Build-mode fallback only — dev mode goes through `ssrLoadModule` so the
 * full transitive import graph rides on Vite's module graph (= helper file
 * edits invalidate automatically = `07-vite-plugin.md` §3 dev/build 対称)。
 *
 * The buster appears as a URL query (= `?t=<mtimeMs>`). Node treats the
 * resulting specifier as a fresh module identity = forces re-evaluation。
 * Transitive imports inside the source (= e.g. `@unworklet/core`) are NOT
 * cache-busted = build mode never sees this because rolldown re-bundles
 * on each build run, but the comment is kept for the (rare) build code path
 * that still routes through here。
 */
const importFresh = async (sourcePath: string): Promise<Record<string, unknown>> => {
  const s = await stat(sourcePath);
  return (await import(`${sourcePath}?t=${s.mtimeMs}`)) as Record<string, unknown>;
};

/**
 * `ssrLoadModule(...)` runs the source through Vite's dev-server module
 * loader = transitive imports show up in `server.moduleGraph` and the
 * watcher invalidates the virtual `?worklet` module when **any** of them
 * change。 Without this path, editing a helper file imported by the
 * processor source leaves the dev server serving stale DSP = a clear
 * dev/build symmetry break。
 *
 * The vite ViteDevServer interface here is intentionally minimal — we only
 * need `ssrLoadModule` for evaluation and `moduleGraph.getModuleById` /
 * `importedModules` for the transitive watch fanout。 Typing this against
 * the full `vite` server interface would force a vite dependency at
 * type-resolution time; the shape is well-known and stable。
 */
type ViteDevServerLike = {
  ssrLoadModule: (url: string) => Promise<Record<string, unknown>>;
  moduleGraph: {
    /**
     * Vite indexes the module graph by file path separately from by
     * resolved id — query suffixes, plugin-resolved virtuals, and
     * normalized URLs make `id` and `file` diverge in real code。 The
     * file-based lookup returns **every** module node attached to a given
     * file path (since the same file can appear under multiple ids =
     * different `?...` queries)。 See vite.dev /guide /api-environment-
     * instances。
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
  // Force a fresh evaluation。 Vite caches `ssrLoadModule`, so without a
  // cache-buster a `.processor.ts` edit is NOT reflected in dev until the dev
  // server restarts — the watcher reloads the virtual `?worklet` module (so
  // `load` re-runs), but `ssrLoadModule` keeps returning the stale evaluation,
  // so `compile` recompiles old source。 Append an integer `?t=` buster (Vite's
  // own HMR cache-bust convention) so each load re-transforms + re-runs the
  // source。
  //
  // `Date.now()` rather than the source mtime: in dev `sourcePath` is a Vite
  // root-relative URL (e.g. `/src/x.ts`), NOT a filesystem path, so it can't be
  // `stat`-ed (the build path's `importFresh` resolves an absolute path and can)。
  // An integer (no `.`) is required — a fractional query (`?t=123.45`) makes
  // Vite read the trailing digits as the file extension, dropping the `.ts`
  // transform。 `compile` is deterministic, so re-evaluating unchanged source
  // still yields the same revision hash (= no spurious `replaceProcessor` churn);
  // only a real edit changes the WASM bytes → new hash → swap。
  return await server.ssrLoadModule(`${sourcePath}?t=${Date.now()}`);
};

/**
 * Recursively collect every file backing a module reachable from
 * `sourcePath` in the dev server's module graph。 The returned `Set`
 * excludes `sourcePath` itself — the plugin's load hook is the canonical
 * watcher for the entry。 Callers pass each transitive file through
 * `this.addWatchFile(...)` so vite re-runs `load` when any of them change。
 *
 * The traversal starts from `getModulesByFile(sourcePath)` (file-based
 * index) rather than `getModuleById(...)`: Vite stores the module under
 * possibly multiple ids for the same file (= query-suffixed variants,
 * plugin-resolved virtuals)、 so id-based lookup misses the dependency
 * fanout whenever `id !== sourcePath` exactly。
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
 *   via `audioWorklet.addModule(...)` on the main thread。
 * - `wasm` = the compiled WASM bytes, fetched on the main thread and handed
 *   to the worklet via `AudioWorkletNodeOptions.processorOptions.wasm`。
 *
 * Build mode emits the same two artifacts via `this.emitFile` so the
 * consumer-side import shape is identical (= dev / build symmetry per
 * `07-vite-plugin.md` §3 「Vite asset pipeline integration」)。
 */
const DEV_URL_PREFIX = "__unworklet";

const encodeSourceForDevUrl = (absPath: string): string =>
  Buffer.from(absPath, "utf8").toString("base64url");

const decodeSourceFromDevUrl = (encoded: string): string =>
  Buffer.from(encoded, "base64url").toString("utf8");

/**
 * 8-hex-char content hash over the compiled WASM bytes。 Used in dev to
 * pin `moduleUrl` and `wasmUrl` to the same compile revision: both URLs
 * carry this token, so even if the author edits and saves between
 * `audioWorklet.addModule(...)` and `fetch(wasmUrl)` the original URLs
 * still resolve to the snapshot they were minted from (= no inline-meta
 * vs WASM bytes skew, `07-vite-plugin.md` §3 dev/build symmetry)。
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
// v1.0.0 convention = 1 source file 1 processor。 `defineProcessor(...)`
// 戻 り 値 を named export し て い れ ば、 plugin が それ を 1 つ pick
// し て `compile()` に 渡 す。 多 重 export / export ナ シ は error を
// throw し て user に refactor を 促 す (= surface 改 訂 ナ シ、 impl-
// detail で の reasonable default)。

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
      `@unworklet/vite-plugin: ${sourcePath} has no defineProcessor exports (a named export of \`defineProcessor(...)\` return value is required).`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `@unworklet/vite-plugin: ${sourcePath} has multiple defineProcessor exports (${matches.join(", ")}); v1.0.0 supports one processor per file.`,
    );
  }
  return found!;
};

const assetBaseName = (sourcePath: string): string => {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  // Strip an optional `.processor` suffix (= canonical fixture convention
  // is `foo.processor.ts`) so emitted assets land at `dist/<processor>.<artifact>`,
  // zipping with the analysis-JSON convention in `07-vite-plugin.md` §6.3.
  return base.endsWith(".processor") ? base.slice(0, -".processor".length) : base;
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
// Phase 6 末尾 5-F DevTools — 1 dock entry に 集 約 し て Vue SPA を host
// ─────────────────────────────────────────────────────────────────────────
//
// `devtools-ui/` の Vue SPA を `ctx.views.hostStatic` 経 由 で 1 iframe panel
// と し て 提 供。 panel 内 で sidebar + 4 view (= Audio graph / Live state /
// Signals / MIDI) を Vue Router で 切 替 = 他 plugin (= Vue/Nuxt DevTools 等)
// を 押 し や ら ない 配 慮。 dummy diagnostics + messages は visual quality
// 確 認 用 の prototype 配 線、 Phase 6 末 尾 で AudioNode.prototype hook +
// AnalyserNode auto-attach + streaming/sharedState/RPC inject に shift。

const setupDevtools = (
  ctx: import("@vitejs/devtools-kit").ViteDevToolsNodeContext,
  uiRoot: string,
): void => {
  const diag = ctx.diagnostics.defineDiagnostics({
    docsBase: "",
    codes: {
      UWK0001: {
        why: (params: { src: string; sym: string }) =>
          `scope-violation: declaration call '${params.sym}' inside expression scope in ${params.src}`,
        fix: "Move the declaration to the top of `defineProcessor((...) => { ... })` body, before the returned `process` lambda.",
      },
      UWK0002: {
        why: "illegal-stride: `forSample.byN` stride must be a compile-time-constant positive integer dividing SAMPLES_PER_BLOCK (= 128).",
        fix: "Pick from 1 / 2 / 4 / 8 / 16 / 32 / 64 / 128.",
      },
      UWK0004: {
        why: "memory-budget: the declaration sum exceeds the 64 MB warning threshold.",
        fix: "Reduce buffer sizes or move large content to a `message<T>` upload pattern.",
      },
      UWK0011: {
        why: (params: { src: string }) =>
          `constant-truthy-emitif: \`emitIf(true, ...)\` inside a \`forSample\` callback at ${params.src} — would emit at audio rate and saturate the ringbuffer.`,
        fix: "Gate the emit on a state-edge expression, or use `everyNSamples(N, ...)`, or move it into a MIDI handler context.",
      },
      UWK0015: {
        why: (params: { src: string; slot: string }) =>
          `unused-named-slot: \`state.i32(0).named('${params.slot}')\` declared at ${params.src} but never referenced.`,
        fix: "Remove the declaration, or drop the `.named(...)` chain to keep the slot worklet-private.",
      },
    },
  });
  ctx.diagnostics.register(diag);

  ctx.diagnostics.logger.UWK0001({
    src: "src/processors/polysynth.processor.ts:84:14",
    sym: "buffer.f32",
  });
  ctx.diagnostics.logger.UWK0002({});
  ctx.diagnostics.logger.UWK0011({
    src: "src/processors/polysynth.processor.ts:51:18",
  });
  ctx.diagnostics.logger.UWK0004({});
  ctx.diagnostics.logger.UWK0015({
    src: "src/processors/arpeggiator.processor.ts:128:6",
    slot: "legacyTickCounter",
  });

  void ctx.messages.add({
    level: "error",
    message: "unworklet: 5 build issues across 3 processors",
    description:
      "polysynth: 3 (scope-violation, constant-truthy-emitif, memory contribution); reverb: 1 (illegal-stride); arpeggiator: 1 (unused-named-slot warning).",
    notify: true,
  });

  ctx.docks.register({
    id: "unworklet",
    title: "unworklet",
    icon: "ph:waveform-duotone",
    type: "iframe",
    url: "/__unworklet/",
  });
  ctx.views.hostStatic("/__unworklet/", uiRoot);
};

// ─────────────────────────────────────────────────────────────────────────
// Plugin factory
// ─────────────────────────────────────────────────────────────────────────

/**
 * Construct the Vite plugin instance. Default export per Vite convention;
 * also re-exported as a named export `unworklet` for explicit import.
 *
 * Phase 5-E status (build mode):
 * - `name` declared
 * - `resolveId` translates `?worklet` imports into `\0unworklet:<abs>` virtual ids
 * - `load` evaluates the source module via Node native TS import, picks the
 *   `defineProcessor(...)` export, runs `compile()` on it, emits the WASM as
 *   a build asset via `this.emitFile`, and (when `emitAnalysisArtifacts` is
 *   enabled = default) also emits 4 sibling metadata JSON files
 *   (`<processor>.graph.json` / `.memory.json` / `.diagnostics.json` /
 *   `.schema-hash.json`) per `07-vite-plugin.md` §6.3. The hook's return
 *   value is a JS module that defers the WASM URL through Rolldown's
 *   `import.meta.ROLLUP_FILE_URL_<refId>`.
 * - Dev-mode middleware path (= ad-hoc WASM serve for `?worklet` requests in
 *   `vp dev`) is filled in a follow-up sub-step.
 */
export default function unworklet(options?: UnworkletPluginOptions): Plugin {
  const emitAnalysisArtifacts = options?.emitAnalysisArtifacts ?? true;
  const uiRoot = resolveDevtoolsUiRoot();
  let isServe = false;
  let basePath = "/";
  // Source paths the plugin has accepted via `?worklet` resolveId. Only these
  // are eligible for dev-mode evaluation + `compile(...)`. Without this gate,
  // the middleware would happily evaluate any absolute path that base64url-
  // encodes into the URL = arbitrary local file import via a crafted dev-
  // server request。
  const allowedSources = new Set<string>();
  // Vite dev server reference for `ssrLoadModule` + transitive watch fan-out。
  // Captured during `configureServer` and consulted by the dev paths inside
  // `load` and the middleware = transitive helper-module edits now flow
  // through Vite's module graph instead of Node's static ESM cache。
  let viteDevServer: ViteDevServerLike | null = null;
  // Dev cache of (sourcePath, revisionHash) → compile snapshot。 Every
  // snapshot holds **all** the per-revision artifacts a single createNode
  // sequence needs (= wasm bytes + extracted meta + processorName) so the
  // moduleUrl's worklet entry load and the wasmUrl's middleware response
  // resolve to the **same** revision even if the author saves between the
  // two requests (= round-5 finding 2 + round-6 finding 2)。 Snapshots stay
  // in a small LRU-ish ring (= keep last 2 revisions) so an in-flight
  // createNode race completes even after a reload triggers a new revision。
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
    // De-dupe by hash, push newest to the end, evict oldest beyond ring size。
    const existing = ring.findIndex((s) => s.hash === snap.hash);
    if (existing >= 0) ring.splice(existing, 1);
    ring.push(snap);
    while (ring.length > SNAPSHOT_RING_SIZE) ring.shift();
    latestRevisionBySource.set(sourcePath, snap.hash);
  };
  const findSnapshot = (sourcePath: string, hash: string): CompileSnapshot | undefined =>
    snapshotsBySource.get(sourcePath)?.find((s) => s.hash === hash);
  return {
    name: "@unworklet/vite-plugin",
    enforce: "pre",
    config(_userConfig, env) {
      // Dev-only gate for the core registry / page bridge: a single statically-
      // replaced boolean — `true` in serve, `false` in build — so production
      // tree-shakes the devtools wiring and tests (no plugin) leave it undefined.
      return {
        define: {
          __UNWORKLET_DEVTOOLS__: env.command === "serve" ? "true" : "false",
        },
      };
    },
    configResolved(config) {
      isServe = config.command === "serve";
      // Dev internal URLs (= `/@id/...`, `/__unworklet/...`) must be
      // request-path absolute so the middleware's `startsWith(...)` match
      // works。 Vite documents `base` may be `'./'` / `''` (= relative,
      // for embedded deployment); in that case the dev server still serves
      // from the absolute origin root, so we fall back to `'/'` for
      // building internal URLs。 Absolute bases (= `'/'` / `'/sub/'`) are
      // preserved so sub-path deployments under a dev server also work。
      if (config.base.startsWith("/")) {
        basePath = config.base.endsWith("/") ? config.base : `${config.base}/`;
      } else {
        basePath = "/";
      }
    },
    transformIndexHtml() {
      if (!isServe) return;
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
      // Dev-mode middleware = serve compiled WASM bytes at a hash-pinned URL。
      // The worklet entry JS is **not** served here — it goes through
      // Vite's module pipeline (= `\0unworklet-worklet:` virtual id under
      // `/@id/`) so Vite's resolver + transform can rewrite the bare
      // `@unworklet/core/worklet` import to a browser-safe URL。 Serving
      // a raw template from custom middleware skips Vite's transform step
      // entirely and the worklet realm would crash on the bare specifier。
      //
      // The URL carries a revision hash so a save between
      // `audioWorklet.addModule(moduleUrl)` and `fetch(wasmUrl)` cannot
      // pair stale inline meta with new WASM bytes — both URLs minted
      // inside a single `createNode` call share the same revision token。
      const devUrlBase = `${basePath}${DEV_URL_PREFIX}/`;
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const queryIdx = req.url.indexOf("?");
        const pathOnly = queryIdx < 0 ? req.url : req.url.slice(0, queryIdx);
        if (!pathOnly.startsWith(devUrlBase)) return next();
        const rest = pathOnly.slice(devUrlBase.length);
        // Expect `<encoded>/<hash>/wasm`。 Any other shape is not ours。
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
        // `?worklet` resolveId may be served by the middleware。
        if (!allowedSources.has(sourcePath)) return next();

        (async (): Promise<void> => {
          // Prefer the in-memory snapshot for the requested revision so a
          // race between save + outstanding fetch resolves to the matching
          // WASM bytes (= no skew with the moduleUrl's inlined meta)。 If
          // the requested revision rolled out of the ring, fall through to
          // a fresh compile (last-resort = strict newer-than-cache request)。
          let bytes: Uint8Array | undefined = findSnapshot(sourcePath, hash)?.wasm;
          if (!bytes) {
            // The middleware was registered via `configureServer`, which
            // captured `viteDevServer` in the same call。 By the time a
            // request reaches here it is guaranteed non-null = assert
            // rather than carry a dead `importFresh` fallback branch
            // that the dev path can never reach。
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
              // failure instead of silently serving a different binary。
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
          console.error("[@unworklet/vite-plugin] middleware error:", err);
          res.statusCode = 500;
          res.end(String(err));
        });
      });
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
        // bare imports (= `@unworklet/core/dev` / `@unworklet/core`).
        return [
          'import { getDevNodes } from "@unworklet/core/dev";',
          'import { decodeScalar, decodeTypedArray } from "@unworklet/core";',
          "globalThis.__unworklet_getDevNodes = getDevNodes;",
          "globalThis.__unworklet_decodeScalar = decodeScalar;",
          "globalThis.__unworklet_decodeTypedArray = decodeTypedArray;",
        ].join("\n");
      }
      if (id.startsWith(WORKLET_ENTRY_PREFIX)) {
        // The id can arrive with a `?v=<hash>` revision query in dev (=
        // Vite passes the full request id including query into `load`)。
        // The query is the only way to look the right per-revision snapshot
        // up — drop the prefix, split off the query, keep going。
        const idAfterPrefix = id.slice(WORKLET_ENTRY_PREFIX.length);
        const queryIdx = idAfterPrefix.indexOf("?");
        const sourcePath = queryIdx < 0 ? idAfterPrefix : idAfterPrefix.slice(0, queryIdx);
        const query = queryIdx < 0 ? "" : idAfterPrefix.slice(queryIdx + 1);
        this.addWatchFile(sourcePath);

        if (isServe) {
          // Dev path = strictly snapshot-driven。 Trust boundary: only
          // sourcePaths the plugin itself accepted via `?worklet`
          // `resolveId` may be evaluated。 Vite exposes virtual ids as
          // `/@id/__x00__<rest>` so an unaudited client could otherwise
          // craft a request for any local file (= round-6 finding 1)。
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
            // Revision rolled out of the ring。 Refuse to silently emit a
            // template against a different revision (= would pair stale
            // meta with new WASM the same way round-5 was meant to close)。
            // Returning `null` makes Vite respond 404, surfacing the skew
            // as a clean addModule() rejection on the consumer side。
            return null;
          }
          return emitWorkletTemplate({
            processorName: snap.processorName,
            meta: snap.meta,
          });
        }

        // Build path: rolldown emits the chunk via `this.emitFile`, snapshot
        // ring not involved。 Recompile + recompute the processorName from
        // the WASM bytes so dev and build produce the same registration name
        // for a given source / revision pair。
        const sourceModule = await importFresh(sourcePath);
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
          : await importFresh(sourcePath);
      // Dev mode: fan watch dependencies out across every transitive file
      // reachable from the processor source = a helper edit invalidates this
      // virtual module just like editing the entry would (= 07-vite-plugin.md
      // §3 dev/build symmetry)。
      if (isServe && viteDevServer) {
        for (const dep of collectTransitiveDeps(viteDevServer, sourcePath)) {
          this.addWatchFile(dep);
        }
      }
      const { exportName, processor } = pickCompiledProcessor(sourceModule, sourcePath);

      const baseName = assetBaseName(sourcePath);

      let moduleUrlExpr: string;
      let wasmUrlExpr: string;
      let processorName: string;

      if (isServe) {
        // Dev: compile up front so we can mint a revision token + cache the
        // snapshot。 Both URLs carry the hash = `addModule(moduleUrl)` and
        // `fetch(wasmUrl)` inside a single `createNode()` always resolve to
        // the same compile snapshot, even if the author saves between the
        // two requests (= no inline-meta vs WASM byte skew)。
        //
        // The worklet entry URL goes through Vite's `/@id/` virtual-module
        // route (= `__x00__` is vite's URL-safe encoding of the `\0` prefix
        // that marks virtual ids), so Vite's transform pipeline can resolve
        // the bare `@unworklet/core/worklet` import inside the emitted
        // template。 Raw middleware output would skip that step and the
        // worklet realm would choke on the bare specifier。
        const result = await compile(processor);
        const hash = computeRevisionHash(result.wasm);
        const devMeta = extractWorkletMeta(
          processor.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
        );
        const devProcessorName = computeProcessorName(exportName, sourcePath, result.wasm);
        // Snapshot the full per-revision bundle = wasm + meta + processorName。
        // The worklet-entry virtual load and the wasm middleware both look
        // their per-request hash up here; both find the same artifacts or
        // both 410, so no path through createNode can pair a stale meta
        // with new bytes (= round-6 finding 2)。
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
        // resolveId / load hooks see)。
        const virtualWorkletUrlPath = `${basePath}@id/__x00__${virtualWorkletId.slice(1)}`;
        moduleUrlExpr = JSON.stringify(`${virtualWorkletUrlPath}?v=${hash}`);
        wasmUrlExpr = JSON.stringify(`${basePath}${DEV_URL_PREFIX}/${encoded}/${hash}/wasm`);
        processorName = devProcessorName;
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

      // virtual module = user source を re-import し て CompiledProcessor を
      // 取り出し、 worklet namespace に bundler URLs (moduleUrl / wasmUrl /
      // processorName) を 載せ た 形 を export。 関数 entry (initialize /
      // process / parameterDescriptors) は 元 namespace を spread で 引き継ぐ。
      // `processorName` は dev / build の 各 branch で WASM revision hash 込 み
      // に 計算 済 (= 同 source の 別 revision で `registerProcessor` 衝突 し な い)。
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
        `  },`,
        `};`,
        ``,
        `export default __unworkletAugmented;`,
        `export { __unworkletAugmented as ${exportName} };`,
        ``,
      ].join("\n");
    },
    handleHotUpdate(ctx) {
      // A processor source edit must re-run the `?worklet` virtual module's
      // `load` (= recompile)。 `addWatchFile` alone does not invalidate the
      // virtual module here, so Vite serves the cached transform and edits are
      // not reflected until the dev server restarts。 Explicitly invalidate the
      // virtual module and steer the HMR update to it: its importer's
      // `import.meta.hot.accept('...?worklet', ...)` then receives a freshly
      // compiled processor (= live-coding via `replaceProcessor`, `07-vite-plugin.md` §4)。
      if (!allowedSources.has(ctx.file)) return;
      const virtualMod = ctx.server.moduleGraph.getModuleById(`${VIRTUAL_ID_PREFIX}${ctx.file}`);
      if (!virtualMod) return;
      ctx.server.moduleGraph.invalidateModule(virtualMod);
      return [virtualMod];
    },
    devtools: {
      setup: (ctx) => setupDevtools(ctx, uiRoot),
    },
  };
}

export { unworklet as unworkletPlugin };
