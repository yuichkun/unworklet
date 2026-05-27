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

import { compile } from "@unworklet/core";
import type { CompiledProcessor } from "@unworklet/core";
import type { Plugin } from "vite-plus";

import { emitWorkletTemplate } from "./worklet-template.ts";

/**
 * Per-source-path suffix appended to the processor export name to derive the
 * `AudioWorkletProcessor` registration name。 AudioWorklet's
 * `registerProcessor(name, klass)` throws `NotSupportedError` on a duplicate
 * name within the same `BaseAudioContext.audioWorklet`, so two unrelated
 * processors that happen to share an export identifier (= e.g. both export
 * `stereoGain`) would collide if registered by export name alone。 Hashing
 * the absolute source path picks a stable, content-independent suffix。
 *
 * 8 hex chars = 32 bit of SHA-256 prefix。 Collision probability across all
 * processor files in any realistic project is negligible (= birthday bound
 * ~65k for ~1% collision)、 and the suffix is fully deterministic per file
 * path so dev / build / re-runs agree。
 */
const PROCESSOR_NAME_HASH_LEN = 8;

const computeProcessorName = (exportName: string, absSourcePath: string): string => {
  const suffix = createHash("sha256")
    .update(absSourcePath)
    .digest("hex")
    .slice(0, PROCESSOR_NAME_HASH_LEN);
  return `${exportName}__${suffix}`;
};

/**
 * Re-import `sourcePath` with a mtime-based cache-buster query so Node's
 * ESM module cache returns the **current** disk content instead of the
 * cached evaluation from the first `import()`。
 *
 * Without this, editing `processor.ts` + full-page reload still serves the
 * stale processor: vite invalidates the `?worklet` virtual module and re-
 * runs `load`, but Node's `import()` keeps returning the cached module from
 * the first hook invocation。
 *
 * The buster appears as a URL query (= `?t=<mtimeMs>`). Node treats the
 * resulting specifier as a fresh module identity = forces re-evaluation。
 * Transitive imports inside the source (= e.g. `@unworklet/core`) are NOT
 * cache-busted = they reuse the existing Node cache。
 */
const importFresh = async (sourcePath: string): Promise<Record<string, unknown>> => {
  const s = await stat(sourcePath);
  return (await import(`${sourcePath}?t=${s.mtimeMs}`)) as Record<string, unknown>;
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
 * Convert an absolute source file path to the URL that vite's dev server
 * serves it at:
 * - Inside project root → `${base}<relative-from-root>` (= e.g. `/src/x.ts`).
 * - Outside project root → `/@fs<abs-path>` (= vite's filesystem-access route).
 *
 * Used by the dev-mode worklet entry template so that
 * `AudioWorkletGlobalScope` can fetch the user processor source via the same
 * dev server that's serving the main page.
 */
const computeServedUrl = (absPath: string, projectRoot: string, base: string): string => {
  const rel = path.relative(projectRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return `/@fs${absPath}`;
  }
  return `${base}${rel}`.replace(/\\/g, "/");
};

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
  let projectRoot = "";
  let basePath = "/";
  return {
    name: "@unworklet/vite-plugin",
    enforce: "pre",
    configResolved(config) {
      isServe = config.command === "serve";
      projectRoot = config.root;
      basePath = config.base.endsWith("/") ? config.base : `${config.base}/`;
    },
    configureServer(server) {
      // Dev-mode middleware = serve the worklet runtime entry (= `worklet.js`)
      // and the compiled WASM bytes at predictable URLs derived from the
      // source path. Same URL shape across consumers — main bundle stores
      // the URL string emitted by `load`、 createNode hands it to
      // `audioWorklet.addModule(...)` + `fetch(...)`、 vite's dev server
      // routes the request here。 Build mode emits the same two assets via
      // `emitFile` so the consumer-side createNode wiring is identical
      // (= `07-vite-plugin.md` §3 dev/build 対称)。
      const devUrlBase = `${basePath}${DEV_URL_PREFIX}/`;
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const queryIdx = req.url.indexOf("?");
        const pathOnly = queryIdx < 0 ? req.url : req.url.slice(0, queryIdx);
        if (!pathOnly.startsWith(devUrlBase)) return next();
        const rest = pathOnly.slice(devUrlBase.length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) return next();
        const encoded = rest.slice(0, slashIdx);
        const part = rest.slice(slashIdx + 1);
        const sourcePath = (() => {
          try {
            return decodeSourceFromDevUrl(encoded);
          } catch {
            return null;
          }
        })();
        if (!sourcePath) return next();

        (async (): Promise<void> => {
          const sourceModule = await importFresh(sourcePath);
          const { exportName, processor } = pickCompiledProcessor(sourceModule, sourcePath);

          if (part === "wasm") {
            const result = await compile(processor);
            res.setHeader("Content-Type", "application/wasm");
            res.setHeader("Cache-Control", "no-cache");
            res.end(Buffer.from(result.wasm));
            return;
          }

          if (part === "worklet.js") {
            const userServedUrl = computeServedUrl(sourcePath, projectRoot, basePath);
            const template = emitWorkletTemplate({
              userSourcePath: userServedUrl,
              processorExportName: exportName,
              processorName: computeProcessorName(exportName, sourcePath),
            });
            res.setHeader("Content-Type", "application/javascript");
            res.setHeader("Cache-Control", "no-cache");
            res.end(template);
            return;
          }

          next();
        })().catch((err: unknown) => {
          console.error("[@unworklet/vite-plugin] middleware error:", err);
          res.statusCode = 500;
          res.end(String(err));
        });
      });
    },
    resolveId(source, importer) {
      if (source.startsWith(WORKLET_ENTRY_PREFIX)) return source;
      const detect = detectWorkletQuery(source);
      if (!detect) return undefined;
      const resolved = resolveAgainstImporter(detect.basePath, importer);
      if (!resolved) return undefined;
      return `${VIRTUAL_ID_PREFIX}${resolved}`;
    },
    async load(id) {
      if (id.startsWith(WORKLET_ENTRY_PREFIX)) {
        const sourcePath = id.slice(WORKLET_ENTRY_PREFIX.length);
        this.addWatchFile(sourcePath);
        const sourceModule = await importFresh(sourcePath);
        const { exportName } = pickCompiledProcessor(sourceModule, sourcePath);
        return emitWorkletTemplate({
          userSourcePath: sourcePath,
          processorExportName: exportName,
          processorName: computeProcessorName(exportName, sourcePath),
        });
      }

      if (!id.startsWith(VIRTUAL_ID_PREFIX)) return undefined;
      const sourcePath = id.slice(VIRTUAL_ID_PREFIX.length);
      // Declare the virtual module's dependency on the source so vite invalidates
      // it when the file changes (= full-page reload picks up edits without
      // restarting the dev server).
      this.addWatchFile(sourcePath);
      const sourceModule = await importFresh(sourcePath);
      const { exportName, processor } = pickCompiledProcessor(sourceModule, sourcePath);

      const baseName = assetBaseName(sourcePath);

      let moduleUrlExpr: string;
      let wasmUrlExpr: string;

      if (isServe) {
        // Dev: middleware serves both assets at predictable URLs derived
        // from the source path. No emitFile / ROLLUP_FILE_URL placeholder
        // (= those are rolldown-build-time only)。 Compile runs lazily inside
        // the middleware on first request, so dev startup stays fast。
        const encoded = encodeSourceForDevUrl(sourcePath);
        moduleUrlExpr = JSON.stringify(`${basePath}${DEV_URL_PREFIX}/${encoded}/worklet.js`);
        wasmUrlExpr = JSON.stringify(`${basePath}${DEV_URL_PREFIX}/${encoded}/wasm`);
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

        if (emitAnalysisArtifacts) {
          this.emitFile({
            type: "asset",
            name: `${baseName}.graph.json`,
            source: `${JSON.stringify(result.graph, null, 2)}\n`,
          });
          this.emitFile({
            type: "asset",
            name: `${baseName}.memory.json`,
            source: `${JSON.stringify(result.memory, null, 2)}\n`,
          });
          this.emitFile({
            type: "asset",
            name: `${baseName}.diagnostics.json`,
            source: `${JSON.stringify(result.diagnostics, null, 2)}\n`,
          });
          this.emitFile({
            type: "asset",
            name: `${baseName}.schema-hash.json`,
            source: `${JSON.stringify({ schemaHash: result.schemaHash }, null, 2)}\n`,
          });
        }
      }

      // virtual module = user source を re-import し て CompiledProcessor を
      // 取り出し、 worklet namespace に bundler URLs (moduleUrl / wasmUrl /
      // processorName) を 載せ た 形 を export。 関数 entry (initialize /
      // process / parameterDescriptors) は 元 namespace を spread で 引き継ぐ。
      const processorName = computeProcessorName(exportName, sourcePath);
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
    devtools: {
      setup: (ctx) => setupDevtools(ctx, uiRoot),
    },
  };
}

export { unworklet as unworkletPlugin };
