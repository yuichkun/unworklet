/**
 * Type-level "type ⟺ works" guard for the opt-in SIMD surface.
 *
 * `lane` / `loadVec` / `storeVec` must be callable ONLY on the element type they
 * support (`Node<'f32x4'>.lane`, `Buffer<'f32'>.loadVec` / `.storeVec`). A wrong
 * element type (a scalar `Node`, a `u8` / `i32` buffer) must be a TYPE error at the
 * call site — otherwise the call compiles and emits out-of-bounds / wrong-type WASM
 * on the audio thread.
 *
 * Real `tsc` diagnostics are collected via the compiler API (mirrors
 * `dsl/op-type-safety.test.ts`), so this asserts what an editor surfaces.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { beforeAll, expect, test } from "vite-plus/test";

let dir: string;

beforeAll(() => {
  const CORE = path.resolve(import.meta.dirname, "..");
  dir = mkdtempSync(path.join(tmpdir(), "uwk-simd-types-"));
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

const SNIPPET = `import { f32, state } from "@unworklet/core";
import { splat } from "@unworklet/core/simd";
declare const v4: ReturnType<typeof splat>;
export function probe() {
  const bf = state.buffer.f32({ size: 16 });
  const bu = state.buffer.u8({ size: 16 });
  bf.loadVec(0);          // L7  valid: f32 buffer
  bf.storeVec(0, v4);     // L8  valid: f32 buffer
  v4.lane(0);             // L9  valid: f32x4 node
  bu.loadVec(0);          // L10 INVALID: u8 buffer has no loadVec
  bu.storeVec(12, v4);    // L11 INVALID: u8 buffer has no storeVec
  f32(1).lane(0);         // L12 INVALID: scalar node has no lane
}
`;

test("SIMD ops: wrong-element calls are type errors, f32/f32x4 stay valid", () => {
  const errs = errorLines(SNIPPET);
  for (const ok of [7, 8, 9]) {
    expect(errs.has(ok), `L${ok} should type-check`).toBe(false);
  }
  for (const bad of [10, 11, 12]) {
    expect(errs.has(bad), `L${bad} (wrong SIMD element type) should be a type error`).toBe(true);
  }
});
