/**
 * The `ts.Program` + `TypeChecker` that backs type-directed lowering. A `.uwk.ts`
 * source plus the ambient `.d.ts` are served from memory by a custom
 * `CompilerHost`; everything else (lib.d.ts, the real `@unworklet/core` source)
 * falls through to disk. `@unworklet/core` resolves to its `src` via the
 * `development` export condition, so the checker reads the real `Node<T>` /
 * `State<T>` brands.
 *
 * The program is built over the PRISTINE source: every type query the lowering
 * passes need must run here, before any AST rewrite (factory nodes carry no
 * checker binding).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { AMBIENT_DTS } from "./ambient.ts";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const AMBIENT_PATH = path.join(SELF_DIR, "__uwk_ambient__.d.ts");
const INPUT_PATH = path.join(SELF_DIR, "__uwk_input__.ts");

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
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

/** Build an in-memory program over `source` (a `.uwk.ts` string) + the ambient. */
export function buildProgram(source: string): BuiltProgram {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);

  const virtuals: Record<string, string> = {
    [AMBIENT_PATH]: AMBIENT_DTS,
    [INPUT_PATH]: source,
  };

  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const text = virtuals[fileName];
    if (text !== undefined) {
      return ts.createSourceFile(fileName, text, languageVersionOrOptions, true, ts.ScriptKind.TS);
    }
    return baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
  };
  host.readFile = (fileName) => virtuals[fileName] ?? baseReadFile(fileName);
  host.fileExists = (fileName) => virtuals[fileName] !== undefined || baseFileExists(fileName);

  const program = ts.createProgram([AMBIENT_PATH, INPUT_PATH], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(INPUT_PATH);
  if (sourceFile === undefined) {
    throw new Error("unworklet/lang: failed to build the .uwk.ts program (input not found)");
  }
  return { program, checker, sourceFile };
}
