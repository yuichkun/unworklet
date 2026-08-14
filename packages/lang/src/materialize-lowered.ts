import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CompiledProcessor } from "@unworklet/core";
import ts from "typescript";

import { lower } from "./lower.ts";
import { COMPILER_OPTIONS } from "./program.ts";
import {
  moduleSpecifiers,
  plainTsModuleSpecifiers,
  relativeModuleSpecifiers,
  rewriteImportSpecifiers,
  runtimeModuleSpecifiers,
  uwkImportSpecifiers,
} from "./uwk-imports.ts";

/** True for a `.uwk.ts` source path (the sugar RFC-001 lowers to a plain `.ts`). */
export const isUwkSource = (filePath: string): boolean => filePath.endsWith(".uwk.ts");

/** The file part of a module specifier. ESM allows a query and a hash on a file
 * URL, so both have to come off before a specifier is classified or resolved. */
const modulePath = (specifier: string): string => specifier.split(/[?#]/)[0]!;

/**
 * A short tag identifying ONE materialization, so no two of them write to the
 * same temp path.
 *
 * A name derived from content alone is shared by every load of that content, and
 * each load's cleanup deletes what it named — so two loads whose entries share a
 * subgraph race over the sibling, and one can unlink a module the other has not
 * imported yet. A `Promise.all` over two processors is enough to hit it, and two
 * CLI or test-worker processes reach the same path just as easily, which is why
 * the tag carries a per-PROCESS part as well as a per-load one.
 *
 * The per-load part is keyed on the caller's `done` map, which is what "one
 * materialization" already means here: callers create a fresh one per load, and
 * the recursion threads it through. Held weakly, so nothing outlives the load it
 * belongs to.
 */
const PROCESS_TAG = `${process.pid.toString(36)}${randomBytes(3).toString("hex")}`;
const loadTags = new WeakMap<object, string>();
let loadCounter = 0;
const loadTag = (done: Map<string, string>): string => {
  let tag = loadTags.get(done);
  if (tag === undefined) {
    tag = `${PROCESS_TAG}${(loadCounter++).toString(36)}`;
    loadTags.set(done, tag);
  }
  return tag;
};

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
 * A digest of every relative module the lowering's type queries can reach from
 * `source` — the rest of the cache key below.
 *
 * `lower()` is type-directed, so a file's desugaring depends on its neighbours'
 * TYPES as much as on its own text. Whether `v.tick(gain)` gains an auto-read
 * turns on whether `tick` declares `State<"f32">` or `Node<"f32">`, and that
 * declaration lives in the sibling. Type-only edges count for exactly the same
 * reason: they carry no runtime dependency but do carry types.
 *
 * Only relative specifiers are followed, and each is resolved by TypeScript
 * rather than read off its spelling.
 */
const typeInputsDigest = (sourcePath: string, source: string): string => {
  const h = createHash("sha256");
  const seen = new Set<string>();
  const queue = moduleSpecifiers(source).map((spec) => ({ spec, from: sourcePath }));
  while (queue.length > 0) {
    const { spec, from } = queue.shift()!;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    // Resolved by TypeScript, with the very options the lowering's program uses
    // — never by the specifier's spelling. Under NodeNext a `"./types.js"`
    // import resolves to `types.ts`, so an extension test drops a file whose
    // types the lowering reads, and the stale key that follows is invisible:
    // neither the importer's text nor its sibling's has changed.
    const resolved = ts.resolveModuleName(spec, from, COMPILER_OPTIONS, ts.sys).resolvedModule;
    if (resolved === undefined) {
      // An unresolvable neighbour belongs in the signature too: creating the
      // file has to invalidate the importer, and this is what changes when it
      // appears. (tsc reports the absence separately.)
      h.update(`${path.resolve(path.dirname(from), spec)} <unresolved> `);
      continue;
    }
    // A dependency inside `node_modules` cannot change between two lowerings in
    // one process, and walking it would mean walking the world.
    const file = resolved.resolvedFileName;
    if (seen.has(file) || file.includes("node_modules")) continue;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      h.update(`${file}\0<absent>\0`);
      continue;
    }
    h.update(`${file}\0${text}\0`);
    for (const next of moduleSpecifiers(text)) queue.push({ spec: next, from: file });
  }
  return h.digest("hex");
};

/**
 * Memoize `lower()`: callers re-evaluate the same source several times per
 * operation (virtual load + worklet entry + middleware in the plugin path) and
 * each `lower()` builds a fresh in-memory ts.Program, so caching the desugared
 * text keeps that cost off the hot path.
 *
 * Keyed by path AND by everything the lowering's type queries read — its own
 * text plus the digest above. Path and text alone are not enough: the dev
 * server rebuilds an importer whose text did not change after a sibling-only
 * edit, and a text-keyed cache would hand back the desugaring of the old
 * sibling's types.
 */
const loweredCache = new Map<string, { source: string; typeInputs: string; lowered: string }>();
export const lowerUwkSource = (sourcePath: string, source: string): string => {
  const typeInputs = typeInputsDigest(sourcePath, source);
  const cached = loweredCache.get(sourcePath);
  if (cached !== undefined && cached.source === source && cached.typeInputs === typeInputs) {
    return cached.lowered;
  }
  // Thread the real path so the type-directed program roots its virtuals in the
  // source's directory — required for sibling `.uwk.ts` subgraph imports to
  // resolve during the sugar passes' type queries (bare-state auto-read,
  // operator dispatch, isDspExpr structural fallback). Guidance-dogfood F-08.
  const lowered = lower(source, {
    exportName: deriveExportName(sourcePath),
    sourcePath,
  });
  loweredCache.set(sourcePath, { source, typeInputs, lowered });
  return lowered;
};

/**
 * Walk the author's own `.ts` helpers, read-only, looking for a `.uwk.ts` they
 * pull in. Returns the first one found with the chain that reached it, or
 * `undefined` if the helpers stay clear of the sugar.
 *
 * Read-only on purpose. These are modules this package does not own: it will
 * look at them to explain a failure, never rewrite them. A helper that cannot be
 * read is skipped — Node reports a missing import far better than a guess here
 * would.
 */
const walkHelperGraph = async (
  fromDir: string,
  specifiers: string[],
): Promise<{
  chain: { via: string; uwk: string; path: string[] } | undefined;
  /** Helpers reached THROUGH another helper — the ones whose module URL this
   * package cannot key on content, because the specifier naming them lives in a
   * file it does not own. Mapped to their current content digest. */
  indirect: Map<string, string>;
}> => {
  const seen = new Set<string>();
  const indirect = new Map<string, string>();
  const queue = specifiers.map((spec) => ({ spec, dir: fromDir, trail: [spec] }));
  while (queue.length > 0) {
    const { spec, dir, trail } = queue.shift()!;
    const file = path.resolve(dir, modulePath(spec));
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    // Tracked when this load cannot key its URL on content: a helper reached
    // through another helper is named by a specifier in a file it does not own.
    if (trail.length > 1) {
      indirect.set(file, createHash("sha256").update(source).digest("hex").slice(0, 8));
    }
    const nextDir = path.dirname(file);
    for (const next of runtimeModuleSpecifiers(source)) {
      if (!next.startsWith("./") && !next.startsWith("../")) continue;
      // Classified by the PATH, never the raw specifier: a query is legal on an
      // ESM file URL, and `"./voice.uwk.ts?rev=1"` matched neither test, so the
      // walk stopped one edge short of exactly what it exists to find.
      const asPath = modulePath(next);
      if (asPath.endsWith(".uwk.ts")) {
        return { chain: { via: trail[0]!, uwk: next, path: [...trail, next] }, indirect };
      }
      if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(asPath))
        queue.push({ spec: next, dir: nextDir, trail: [...trail, next] });
    }
  }
  return { chain: undefined, indirect };
};

/**
 * Content digests of the indirect helpers this process has already loaded.
 *
 * Node's module cache is permanent, and only a helper the temp imports DIRECTLY
 * can have its URL keyed on content — one reached through another helper is
 * resolved by a specifier in a file this package does not own and will not
 * rewrite. Re-evaluating the outer helper does not rescue it either: Node
 * resolves its `./b.mjs` to the same URL and returns the cached module.
 *
 * So the one thing left is to not be quiet about it. If such a file changed
 * since this process loaded it, the next load WOULD compile the old version, and
 * that is reported instead.
 */
const loadedIndirectHelpers = new Map<string, string>();

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
  const lowered = lowerUwkSource(sourcePath, source);
  const dir = path.dirname(sourcePath);
  // Strip types here so the temp is plain ESM every supported Node can import.
  // `sourcePath` is passed as the file name purely for diagnostics.
  //
  // Emitted BEFORE dependencies are looked for, because the emit is the module
  // graph. Which specifiers survive is not readable off the declarations: a
  // type-only clause goes, and so does any import whose bindings end up unused,
  // whatever shape it has. Walking a specifier Node never resolves invents a
  // dependency — and an invented back-edge is reported as a cyclic import for a
  // graph that has no cycle in it.
  let emitted = ts.transpileModule(lowered, {
    fileName: sourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      // Keep specifiers exactly as written; the remap below points them at temps.
      verbatimModuleSyntax: false,
    },
  }).outputText;
  const remap: Record<string, string> = {};
  for (const spec of uwkImportSpecifiers(emitted)) {
    // The file part only — a sibling can be imported as `"./voice.uwk.ts?rev=1"`,
    // and the query belongs to the specifier, not to the path on disk.
    const targetTemp = await materializeLowered(
      path.resolve(dir, modulePath(spec)),
      done,
      inProgress,
      cleanup,
    );
    let rel = path.relative(dir, targetTemp).split(path.sep).join("/");
    // The temp basename is a dotfile (`.x.<tag>.uwklowered.mjs`), so a same-dir
    // `path.relative` yields a leading-dot name that Node would read as a bare
    // specifier — force an explicit `./` (or keep an existing `../`).
    if (!rel.startsWith("./") && !rel.startsWith("../")) rel = `./${rel}`;
    remap[spec] = rel;
  }
  if (Object.keys(remap).length > 0) emitted = rewriteImportSpecifiers(emitted, remap);
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
  const plain = plainTsModuleSpecifiers(emitted);
  if (plain.length > 0 && !process.features.typescript) {
    throw new Error(
      `@unworklet/lang: ${path.basename(sourcePath)} imports ${plain.map((s) => `"${s}"`).join(", ")}, ` +
        `and this Node (${process.version}) cannot load TypeScript. Either run Node 22.18+ / 23.6+, ` +
        `which strips types natively as long as the helper is erasable (an enum or namespace ` +
        `still will not load), or give the helper a JavaScript extension (rename to .mjs and ` +
        `import it as "./helper.mjs"). Sibling .uwk.ts imports are unaffected — those are ` +
        `lowered to JavaScript for you.`,
    );
  }

  // Every helper the temp still points at — JavaScript ones too, not just the
  // TypeScript ones above. A `.mjs` helper reaches a `.uwk.ts` exactly as easily,
  // and it is what the message above recommends renaming to.
  const helpers = relativeModuleSpecifiers(emitted).filter((s) => !s.includes(".uwklowered."));

  // Node loads whatever a helper points at — including a `.uwk.ts`, raw. That
  // file's authoring globals only exist after lowering, so evaluation dies on
  // `defineSubgraph is not defined` with nothing naming the helper that led
  // there. Reporting is the whole fix available: rewriting the helper's
  // specifier means rewriting a module this package does not own, which is the
  // line drawn just above.
  const { chain, indirect } = await walkHelperGraph(dir, helpers);
  if (chain !== undefined) {
    throw new Error(
      `@unworklet/lang: ${path.basename(sourcePath)} reaches "${chain.uwk}" through the helper ` +
        `"${chain.via}" (${[path.basename(sourcePath), ...chain.path].join(" → ")}). ` +
        `A .uwk.ts has to be lowered before Node can load it, and only .uwk.ts files are ` +
        `rewritten — rewriting your own modules would mean guessing their tsconfig. Import ` +
        `the .uwk.ts directly from a .uwk.ts, or make the helper a .uwk.ts itself (a subgraph ` +
        `library module: exports, no process()).`,
    );
  }

  // Node's ESM cache is permanent and keyed by URL, so a second load in the same
  // process would re-read the (cache-busted) temp and then reuse the FIRST run's
  // helper module — compiling the old constants into the new graph, silently.
  // Keying each helper URL on its content means an unchanged helper is still
  // shared, and a changed one is a different module.
  //
  // This reaches one level; anything deeper is covered by the check below.
  const bust: Record<string, string> = {};
  for (const spec of helpers) {
    const file = path.resolve(dir, modulePath(spec));
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue; // not on disk — let Node report the missing import
    }
    const rev = createHash("sha256").update(content).digest("hex").slice(0, 8);
    // Appended to the query, ahead of any fragment, so an author's own query or
    // hash survives intact.
    const [head, ...rest] = spec.split("#");
    const withRev = `${head!}${head!.includes("?") ? "&" : "?"}uwkrev=${rev}`;
    bust[spec] = rest.length > 0 ? `${withRev}#${rest.join("#")}` : withRev;
  }
  if (Object.keys(bust).length > 0) emitted = rewriteImportSpecifiers(emitted, bust);

  // What the busting above cannot reach: a helper named by another helper. If one
  // of those changed since this process loaded it, Node will hand back the old
  // module and the graph would be built from it, with nothing to show for it.
  for (const [file, rev] of indirect) {
    const before = loadedIndirectHelpers.get(file);
    if (before !== undefined && before !== rev) {
      throw new Error(
        `@unworklet/lang: ${path.basename(file)} changed since this process first loaded it, and ` +
          `it is reached through another helper rather than from ${path.basename(sourcePath)} ` +
          `directly. Node's module cache is permanent and the specifier naming it lives in a file ` +
          `this package does not rewrite, so the previous version is what would be compiled. ` +
          `Restart the process to pick up the change, or import ${path.basename(file)} from your ` +
          `.uwk.ts directly — helpers imported there are reloaded for you.`,
      );
    }
    loadedIndirectHelpers.set(file, rev);
  }

  const tag = createHash("sha256").update(emitted).digest("hex").slice(0, 8);
  const tempPath = path.join(
    dir,
    `.${path.basename(sourcePath)}.${tag}.${loadTag(done)}.uwklowered.mjs`,
  );
  await writeFile(tempPath, emitted);
  done.set(sourcePath, tempPath);
  inProgress.delete(sourcePath);
  cleanup.push(tempPath);
  return tempPath;
};

/**
 * Import a materialized temp, translating Node's strip-only refusal into an
 * error that names this toolchain and a way out.
 *
 * The capability guard in `materializeLowered` answers one question: can this
 * Node load TypeScript at all. Node 22.18+ answers yes — but only for ERASABLE
 * TypeScript. An `enum`, a `namespace` or a parameter property in a helper needs
 * a real transform, which Node applies only behind
 * `--experimental-transform-types`. So a consumer who takes the guard's advice
 * and upgrades Node can still land on `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, with
 * nothing tying it back to the `.uwk.ts` they were loading.
 *
 * Catching covers what a check could not: any construct, at any import depth,
 * under whatever rules the running Node applies — no list here to fall behind
 * Node's. The original is kept as `cause`, since its stack is what names the
 * offending file and line.
 */
export async function importLoweredEntry(
  entryTemp: string,
  sourcePath: string,
): Promise<Record<string, unknown>> {
  // A file URL, not a path: an absolute POSIX path happens to work, but a
  // Windows path (drive letter = URL scheme) or a name without a `./` prefix
  // does not. The query keeps repeat loads out of the ESM cache.
  const href = `${pathToFileURL(entryTemp).href}?t=${Date.now()}`;
  try {
    return (await import(href)) as Record<string, unknown>;
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw err;
    throw new Error(
      `@unworklet/lang: loading ${path.basename(sourcePath)} reached a .ts helper that needs a ` +
        `real TypeScript transform, and this Node (${process.version}) only strips types — ` +
        `${(err as Error).message}. Node transforms only behind --experimental-transform-types. ` +
        `Either keep the helper erasable (a const object rather than an enum, for instance) or ` +
        `give it a JavaScript extension (rename to .mjs and import it as "./helper.mjs"). ` +
        `Sibling .uwk.ts imports are unaffected — those are lowered to JavaScript for you.`,
      { cause: err },
    );
  }
}

/**
 * The file loaded and evaluated cleanly; it just is not a processor.
 *
 * A subgraph library — the documented multi-file pattern, exports and no
 * `process()` — is exactly this, and it belongs to a normal project. Anything
 * scanning a whole tsconfig has to tell "not a processor" apart from "a
 * processor that would not compile", or the recommended layout reads as broken.
 */
export class NotAProcessorError extends Error {
  override readonly name = "NotAProcessorError";
}

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
    const mod = await importLoweredEntry(entryTemp, sourcePath);
    const matches: string[] = [];
    let found: CompiledProcessor<unknown> | undefined;
    for (const key of Object.keys(mod)) {
      if (isCompiledProcessor(mod[key])) {
        matches.push(key);
        found = mod[key] as CompiledProcessor<unknown>;
      }
    }
    if (matches.length === 0) {
      throw new NotAProcessorError(
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
