/**
 * Type-level "type ⟺ works" guard for the free-function numeric ops.
 *
 * The method forms (`a.clamp(b, c)` …) already reject a mix of two concrete
 * scalar types because the receiver fixes `T`. The free-function forms
 * (`clamp(a, b, c)`, what `.uwk.ts` sugar desugars to) inferred `T` as a UNION
 * and silently accepted `clamp(i32, 0, f32)` — which then compiled to invalid
 * WASM. Per-type overloads make a typed-node-vs-typed-node mismatch a TYPE
 * error, while number literals stay flexible (every overload accepts a number,
 * anywhere) so number-first / all-number calls keep working.
 *
 * Real `tsc` diagnostics are collected via the compiler API (mirrors
 * `node-types.test.ts`), so this asserts what an editor surfaces, not internals.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { beforeAll, expect, test } from "vite-plus/test";

let dir: string;

beforeAll(() => {
  const CORE = path.resolve(import.meta.dirname, "..", "..");
  dir = mkdtempSync(path.join(tmpdir(), "uwk-op-types-"));
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

/** Line numbers (1-based) of the fixture that carry a semantic type error. */
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

const SNIPPET = `import { add, clamp, f32, i32, max, min, select } from "@unworklet/core";
declare const ai: ReturnType<typeof i32>;
declare const bf: ReturnType<typeof f32>;
export function probe() {
  clamp(i32(1), 0, i32(5));   // L5  valid: same type
  clamp(f32(1), 0, 5);        // L6  valid: node + numbers
  max(0, bf);                 // L7  valid: number-first
  clamp(0, 0, 5);             // L8  valid: all numbers (→ f32)
  clamp(f32(0), 0, f32(1));   // L9  valid: f32 literal + f32 node
  select(true, f32(1), 0);    // L10 valid: numeric select (f32 + number)
  select(true, true, false);  // L11 valid: bool select
  clamp(ai, 0, bf);           // L12 INVALID: i32/f32 mix (free fn)
  min(ai, bf);                // L13 INVALID: i32/f32 mix (free fn)
  add(ai, bf);                // L14 INVALID: i32/f32 mix (free fn)
  select(true, ai, bf);       // L15 INVALID: i32/f32 mix (select branches)
  ai.add(bf);                 // L16 INVALID: i32/f32 mix (method, already caught)
}
`;

test("numeric ops: typed-node mismatch errors, literals/number-first stay valid", () => {
  const errs = errorLines(SNIPPET);
  for (const ok of [5, 6, 7, 8, 9, 10, 11]) {
    expect(errs.has(ok), `L${ok} should type-check`).toBe(false);
  }
  for (const bad of [12, 13, 14, 15, 16]) {
    expect(errs.has(bad), `L${bad} (scalar-type mix) should be a type error`).toBe(true);
  }
  // Spins a full ts.Program (typechecks the whole source); generous timeout so it
  // survives CPU contention when the suite runs many files in parallel.
}, 30000);
