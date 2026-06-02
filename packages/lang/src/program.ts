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

// `import.meta.dirname` is a plain string in Node and `undefined` in the browser
// — a property read, NOT a `node:url` / `node:path` import (those externalize and
// crash the browser bundle). In the browser a snapshot is always supplied, so the
// disk-relative paths below are never resolved against a real file system; they
// are just stable keys that match the captured snapshot.
const SELF_DIR = (import.meta as { dirname?: string }).dirname ?? "/__uwk__";
const AMBIENT_PATH = `${SELF_DIR}/__uwk_ambient__.d.ts`;
const INPUT_PATH = `${SELF_DIR}/__uwk_input__.ts`;

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
  };
}

const virtualsFor = (source: string): Record<string, string> => ({
  [AMBIENT_PATH]: AMBIENT_DTS,
  [INPUT_PATH]: source,
});

/** A host that answers purely from a captured snapshot — no disk, no `ts.sys`. */
function replayHost(source: string, snap: FsSnapshot): ts.CompilerHost {
  const virtuals = virtualsFor(source);
  const text = (fileName: string): string | undefined =>
    virtuals[fileName] ?? snap.sourceTexts[fileName];
  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      const content = text(fileName);
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
    getDirectories: (dir) => snap.dirs[dir] ?? [],
    realpath: (p) => snap.realpath[p] ?? p,
    writeFile: () => undefined,
    getDefaultLibFileName: () => snap.defaultLibFileName,
    getCurrentDirectory: () => snap.currentDirectory,
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
  }
  const virtuals = virtualsFor(source);
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
    if (virtuals[fileName] !== undefined) return virtuals[fileName];
    const content = base.readFile(fileName);
    if (record && content !== undefined) record.sourceTexts[fileName] = content;
    return content;
  };
  host.fileExists = (fileName) => {
    if (virtuals[fileName] !== undefined) return true;
    const exists = base.fileExists(fileName);
    if (record) record.fileExists[fileName] = exists;
    return exists;
  };
  if (base.directoryExists) {
    host.directoryExists = (dir) => {
      const exists = base.directoryExists!(dir);
      if (record) record.dirExists[dir] = exists;
      return exists;
    };
  }
  if (base.getDirectories) {
    host.getDirectories = (dir) => {
      const dirs = base.getDirectories!(dir);
      if (record) record.dirs[dir] = dirs;
      return dirs;
    };
  }
  if (base.realpath) {
    host.realpath = (p) => {
      const rp = base.realpath!(p);
      if (record) record.realpath[p] = rp;
      return rp;
    };
  }
  return host;
}

function buildFrom(source: string, host: ts.CompilerHost): BuiltProgram {
  const program = ts.createProgram([AMBIENT_PATH, INPUT_PATH], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(INPUT_PATH);
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
    return buildFrom(source, replayHost(source, options.snapshot));
  }
  return buildFrom(source, diskHost(source, options.record));
}
