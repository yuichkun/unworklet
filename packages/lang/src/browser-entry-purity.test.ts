/**
 * `@unworklet/lang/browser` compiles a `.uwk.ts` source string in the browser,
 * so nothing it reaches may import a `node:*` builtin. Those are not bundled:
 * Vite replaces them with a stub that throws the moment a property is read, and
 * the throw surfaces far from the import that caused it — a module could sit
 * broken for a whole release because the one code path touching it happened not
 * to run.
 *
 * The build only warns ("Module … has been externalized for browser
 * compatibility"), and a warning in a green build is a warning nobody reads.
 * So the rule is checked here instead, over the whole graph the entry pulls in.
 *
 * Reported by @codex on #43.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { expect, test } from "vite-plus/test";

const SRC = import.meta.dirname;

/** Every module specifier a source names, imports and re-exports alike. */
function specifiersOf(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) continue;
    const s = stmt.moduleSpecifier;
    if (s !== undefined && ts.isStringLiteral(s)) out.push(s.text);
  }
  return out;
}

/** The relative module graph rooted at `entry`, plus every bare specifier seen. */
function walk(entry: string): { files: string[]; bare: { from: string; spec: string }[] } {
  const files: string[] = [];
  const bare: { from: string; spec: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const spec of specifiersOf(readFileSync(file, "utf8"), file)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        bare.push({ from: path.relative(SRC, file), spec });
        continue;
      }
      queue.push(path.resolve(path.dirname(file), spec));
    }
  }
  return { files, bare };
}

test("nothing reachable from the browser entry imports a node: builtin", () => {
  const { files, bare } = walk(path.join(SRC, "browser.ts"));
  // A graph that failed to expand would make this vacuously green.
  expect(files.length).toBeGreaterThan(3);

  const builtins = bare
    .filter(({ spec }) => spec.startsWith("node:"))
    .map(({ from, spec }) => `${from} imports ${spec}`);
  expect(builtins).toEqual([]);
});
