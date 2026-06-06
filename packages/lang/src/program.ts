/**
 * The `ts.Program` + `TypeChecker` that backs type-directed lowering. A `.uwk.ts`
 * source plus the ambient `.d.ts` are served from memory; the lib files and the
 * real `@unworklet/core` source resolve through a host that is EITHER disk-backed
 * (Node) OR a replay of a previously-captured file-system snapshot (browser).
 *
 * The program is built over the PRISTINE source: every type query the lowering
 * passes need must run here, before any AST rewrite (factory nodes carry no
 * checker binding).
 *
 * Browser support: the `.uwk.ts` input imports nothing (every authoring name is
 * an ambient global), so the module graph the checker walks — the ambient plus
 * the whole `@unworklet/core` type surface plus the lib files — is IDENTICAL
 * regardless of the input. Capturing every host answer once (in Node, via
 * `captureFsSnapshot`) therefore yields a serializable snapshot that replays the
 * exact same resolution in the browser, with no `node:*` import and no disk
 * access. Only the input source text differs per call and is overlaid on top.
 */

import ts from "typescript";

import { AMBIENT_DTS } from "./ambient.ts";

// The directory the in-memory virtuals are placed under, which disk-backed module
// resolution (Node) walks up from to find `@unworklet/core`. `import.meta.dirname`
// is a plain string under Node ESM and `undefined` in the browser — a property
// read, NOT a `node:url` / `node:path` import (those externalize and crash the
// browser bundle). The editor TS-plugin is bundled to CJS, where `import.meta` is
// empty but esbuild supplies `__dirname` (the bundle's dir, which sits in
// `node_modules/@unworklet/lang/dist`, so core resolves from the same install) —
// `typeof __dirname` is the one safe way to reach it without a ReferenceError in
// ESM. In the browser a snapshot is always supplied, so these paths are never
// resolved against disk; they are just stable keys matching the captured snapshot.
/* v8 ignore next 3 — environment detection: under the Node ESM test runner
   `import.meta.dirname` is always set, so the CJS-bundle (`__dirname`, used by the
   editor TS plugin) and browser (`/__uwk__`) fallbacks are unreachable here. */
const SELF_DIR =
  (import.meta as { dirname?: string }).dirname ??
  (typeof __dirname === "string" ? __dirname : "/__uwk__");

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  // ES libs only — NOT the DOM lib. DOM declares a non-generic `interface Node`,
  // which would collide with the ambient's generic `Node<T>` alias (making a
  // `Node<"f32">` annotation an error that resolves to `any`).
  lib: ["lib.es2023.d.ts"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  // @unworklet/core's package.json exports a `development` condition → src/*.ts,
  // so the checker sees real types rather than the built .d.ts.
  customConditions: ["development"],
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  // Operand type queries don't need strictness; off is faster and avoids
  // spurious errors on the intentionally operator-erroring source.
  strict: false,
  esModuleInterop: true,
};

export type BuiltProgram = {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** The pristine `.uwk.ts` SourceFile — query against this, never a rewritten tree. */
  sourceFile: ts.SourceFile;
};

/**
 * A serializable capture of every host answer the program needed (minus the
 * per-call input source). Replaying it reproduces the exact module resolution in
 * an environment with no disk and no `node:*` (= the browser).
 */
export type FsSnapshot = {
  /** `readFile` / `getSourceFile` content, keyed by the path the host asked for. */
  sourceTexts: Record<string, string>;
  /** Recorded boolean results of `fileExists`. */
  fileExists: Record<string, boolean>;
  /** Recorded boolean results of `directoryExists`. */
  dirExists: Record<string, boolean>;
  /** Recorded `getDirectories` results. */
  dirs: Record<string, string[]>;
  /** Recorded `realpath` results. */
  realpath: Record<string, string>;
  /** `getDefaultLibFileName(COMPILER_OPTIONS)`. */
  defaultLibFileName: string;
  /** `getCurrentDirectory()`. */
  currentDirectory: string;
  useCaseSensitiveFileNames: boolean;
  newLine: string;
  /**
   * The directory the entry virtuals (`__uwk_input__.ts` / `__uwk_ambient__.d.ts`)
   * were placed under WHEN THE SNAPSHOT WAS RECORDED. Module resolution starts from
   * this directory, so every recorded `fileExists` / `directoryExists` /
   * `getDirectories` / `realpath` key is derived from it. Replay MUST build the
   * program with the same entry directory, otherwise the checker asks for
   * differently-rooted paths the snapshot never recorded, `@unworklet/core`'s types
   * fail to resolve, and type-directed lowering silently degrades to a no-op.
   */
  selfDir: string;
};

export type BuildProgramOptions = {
  /** Replay this snapshot instead of touching disk (browser mode). */
  snapshot?: FsSnapshot;
  /**
   * Record every disk answer into this snapshot (Node mode). The host stays live
   * through the lowering passes, so this captures the LAZY `import("...")` type
   * resolutions the passes trigger — not just the eager program build.
   */
  record?: FsSnapshot;
};

/** A fresh, empty snapshot ready to be filled by a recording `buildProgram` run. */
export function emptySnapshot(): FsSnapshot {
  return {
    sourceTexts: {},
    fileExists: {},
    dirExists: {},
    dirs: {},
    realpath: {},
    defaultLibFileName: "",
    currentDirectory: "",
    useCaseSensitiveFileNames: true,
    newLine: "\n",
    // Seeded with the record-time directory; replay overrides the live SELF_DIR
    // with the snapshot's value so the entry paths match what was recorded.
    selfDir: SELF_DIR,
  };
}

const ambientPathFor = (selfDir: string): string => `${selfDir}/__uwk_ambient__.d.ts`;
const inputPathFor = (selfDir: string): string => `${selfDir}/__uwk_input__.ts`;

const virtualsFor = (source: string, selfDir: string): Record<string, string> => ({
  [ambientPathFor(selfDir)]: AMBIENT_DTS,
  [inputPathFor(selfDir)]: source,
});

/** A host that answers purely from a captured snapshot — no disk, no `ts.sys`. */
function replayHost(source: string, snap: FsSnapshot): ts.CompilerHost {
  // Use the snapshot's record-time directory so the entry paths — and therefore
  // every module-resolution lookup the checker derives from them — match the
  // recorded keys exactly.
  const virtuals = virtualsFor(source, snap.selfDir);
  const text = (fileName: string): string | undefined =>
    virtuals[fileName] ?? snap.sourceTexts[fileName];
  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      const content = text(fileName);
      // Every file the checker requests during replay is present in the snapshot
      // (the captured graph is complete), so the `undefined` arm is defensive.
      /* v8 ignore next */
      return content === undefined
        ? undefined
        : ts.createSourceFile(fileName, content, languageVersionOrOptions, true, ts.ScriptKind.TS);
    },
    readFile: (fileName) => text(fileName),
    fileExists: (fileName) =>
      virtuals[fileName] !== undefined ||
      snap.sourceTexts[fileName] !== undefined ||
      snap.fileExists[fileName] === true,
    directoryExists: (dir) => snap.dirExists[dir] === true,
    // The `?? []` / `?? p` fallbacks only fire for a key the snapshot never recorded;
    // a complete capture answers every lookup, so they are defensive normalization.
    /* v8 ignore next 2 */
    getDirectories: (dir) => snap.dirs[dir] ?? [],
    realpath: (p) => snap.realpath[p] ?? p,
    writeFile: () => undefined,
    getDefaultLibFileName: () => snap.defaultLibFileName,
    getCurrentDirectory: () => snap.currentDirectory,
    // `useCaseSensitiveFileNames` mirrors the recording host; on a case-insensitive
    // file system only the `toLowerCase()` arm runs, on a case-sensitive one only
    // the identity arm — one side is always dead for a given recording environment.
    /* v8 ignore next */
    getCanonicalFileName: (f) => (snap.useCaseSensitiveFileNames ? f : f.toLowerCase()),
    useCaseSensitiveFileNames: () => snap.useCaseSensitiveFileNames,
    getNewLine: () => snap.newLine,
  };
}

/** Disk-backed host (Node) that overlays the in-memory virtuals and, when asked,
 * records every answer into `record` so the run can later be replayed off-disk. */
function diskHost(source: string, record?: FsSnapshot): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  if (record) {
    record.defaultLibFileName = host.getDefaultLibFileName(COMPILER_OPTIONS);
    record.currentDirectory = host.getCurrentDirectory();
    record.useCaseSensitiveFileNames = host.useCaseSensitiveFileNames();
    record.newLine = host.getNewLine();
    record.selfDir = SELF_DIR;
  }
  const virtuals = virtualsFor(source, SELF_DIR);
  const base = {
    getSourceFile: host.getSourceFile.bind(host),
    readFile: host.readFile.bind(host),
    fileExists: host.fileExists.bind(host),
    directoryExists: host.directoryExists?.bind(host),
    getDirectories: host.getDirectories?.bind(host),
    realpath: host.realpath?.bind(host),
  };

  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const v = virtuals[fileName];
    if (v !== undefined) {
      return ts.createSourceFile(fileName, v, languageVersionOrOptions, true, ts.ScriptKind.TS);
    }
    const sf = base.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    // Record the on-disk content (not the per-call input/ambient virtuals).
    if (record && sf !== undefined) record.sourceTexts[fileName] = sf.text;
    return sf;
  };
  host.readFile = (fileName) => {
    // The virtuals are served through `getSourceFile`; the program build never
    // routes them through `readFile`, so the virtual short-circuit is defensive.
    /* v8 ignore next */
    if (virtuals[fileName] !== undefined) return virtuals[fileName];
    const content = base.readFile(fileName);
    if (record && content !== undefined) record.sourceTexts[fileName] = content;
    return content;
  };
  host.fileExists = (fileName) => {
    // Same as `readFile`: resolution checks the virtuals via `getSourceFile`, not
    // through `fileExists`, so this short-circuit is defensive.
    /* v8 ignore next */
    if (virtuals[fileName] !== undefined) return true;
    const exists = base.fileExists(fileName);
    if (record) record.fileExists[fileName] = exists;
    return exists;
  };
  // `ts.createCompilerHost` always supplies these three methods on Node, so the
  // `false` arm (host lacks the method) is unreachable in this environment.
  /* v8 ignore next */
  if (base.directoryExists) {
    host.directoryExists = (dir) => {
      const exists = base.directoryExists!(dir);
      if (record) record.dirExists[dir] = exists;
      return exists;
    };
  }
  /* v8 ignore next */
  if (base.getDirectories) {
    host.getDirectories = (dir) => {
      const dirs = base.getDirectories!(dir);
      if (record) record.dirs[dir] = dirs;
      return dirs;
    };
  }
  /* v8 ignore next */
  if (base.realpath) {
    host.realpath = (p) => {
      const rp = base.realpath!(p);
      if (record) record.realpath[p] = rp;
      return rp;
    };
  }
  return host;
}

function buildFrom(source: string, host: ts.CompilerHost, selfDir: string): BuiltProgram {
  const inputPath = inputPathFor(selfDir);
  const program = ts.createProgram([ambientPathFor(selfDir), inputPath], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(inputPath);
  // `inputPath` is one of the two files passed to `createProgram` and the host
  // always serves it, so the program always contains it — a defensive guard.
  /* v8 ignore next 3 */
  if (sourceFile === undefined) {
    throw new Error("unworklet/lang: failed to build the .uwk.ts program (input not found)");
  }
  return { program, checker, sourceFile };
}

/**
 * Build an in-memory program over `source` (a `.uwk.ts` string) + the ambient.
 * Replays `options.snapshot` (browser, no disk) when given; otherwise reads from
 * disk and, if `options.record` is supplied, records every answer into it. The
 * recording host is held by the returned program, so reads that the lowering
 * passes trigger afterwards are captured too.
 */
export function buildProgram(source: string, options: BuildProgramOptions = {}): BuiltProgram {
  if (options.snapshot !== undefined) {
    // Replay: build with the snapshot's record-time directory so resolution
    // matches the recorded host answers (the live SELF_DIR is the browser's
    // `/__uwk__` fallback, which would never match a Node-recorded snapshot).
    return buildFrom(source, replayHost(source, options.snapshot), options.snapshot.selfDir);
  }
  return buildFrom(source, diskHost(source, options.record), SELF_DIR);
}
