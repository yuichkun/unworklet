/**
 * Type-level "type ⟺ works" guard for `instantiate(subgraph, ...args, options?)`.
 *
 * The subgraph's lambda-arg tuple `Args` must be enforced at the call site: wrong-
 * typed, missing, or too-few args must be a TYPE error — otherwise the body runs at
 * graph capture with bad values (`'wrong'.mul(...)` → TypeError) or captures a
 * malformed graph. A trailing `{ name }` options object stays accepted.
 *
 * Real `tsc` diagnostics via the compiler API (mirrors `dsl/op-type-safety.test.ts`).
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { beforeAll, expect, test } from "vite-plus/test";

let dir: string;

beforeAll(() => {
  const CORE = path.resolve(import.meta.dirname, "..");
  dir = mkdtempSync(path.join(tmpdir(), "uwk-subgraph-types-"));
  mkdirSync(path.join(dir, "node_modules/@unworklet"), { recursive: true });
  symlinkSync(CORE, path.join(dir, "node_modules/@unworklet/core"));
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        customConditions: ["development"],
        allowImportingTsExtensions: true,
        lib: ["es2023", "dom"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
    }),
  );
});

function errorLines(snippet: string): Set<number> {
  const file = path.join(dir, `fix-${Math.abs(hash(snippet))}.ts`);
  writeFileSync(file, snippet);
  const read = ts.readConfigFile(path.join(dir, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir);
  const program = ts.createProgram({ rootNames: [file], options: parsed.options });
  const lines = new Set<number>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.file?.fileName === file && d.start != null) {
      lines.add(d.file.getLineAndCharacterOfPosition(d.start).line + 1);
    }
  }
  return lines;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

const SNIPPET = `import { defineSubgraph, instantiate, f32 } from "@unworklet/core";
import type { Node } from "@unworklet/core";
const osc = defineSubgraph((freq: Node<"f32">, gain: Node<"f32">) => ({
  tick: () => freq.add(gain),
}));
export function probe() {
  instantiate(osc, f32(1), f32(2));                  // L7  valid: correct args
  instantiate(osc, f32(1), f32(2), { name: "x" });   // L8  valid: args + options
  instantiate(osc, "wrong", 123);                    // L9  INVALID: wrong arg types
  instantiate(osc);                                  // L10 INVALID: missing args
  instantiate(osc, f32(1));                          // L11 INVALID: too few args
}
`;

test("instantiate: wrong/missing subgraph args are type errors, correct args + options stay valid", () => {
  const errs = errorLines(SNIPPET);
  for (const ok of [7, 8]) {
    expect(errs.has(ok), `L${ok} should type-check`).toBe(false);
  }
  for (const bad of [9, 10, 11]) {
    expect(errs.has(bad), `L${bad} (bad subgraph args) should be a type error`).toBe(true);
  }
  // Spins a full ts.Program (typechecks the whole source); generous timeout so it
  // survives CPU contention when the suite runs many files in parallel.
}, 30000);
