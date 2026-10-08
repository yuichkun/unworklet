/**
 * Guard for the SHIPPED type surface (`dist/*.d.mts`), which `vp check` never
 * sees: package resolution uses the `development` / `types` export condition, so
 * `vp check` only ever type-checks `src`. A `.d.ts` that builds clean from src can
 * still ship a broken surface — e.g. a cross-file `declare module "../types.ts"`
 * augmentation that the dts bundler orphans, dropping every `Node` chain method
 * for consumers while the free-function form survives.
 *
 * This builds the dist from the current src and type-checks a consumer fixture
 * against `dist` (not `src`) with stock TypeScript — the same path the isolated
 * tgz-install verification exercises, but as an in-repo regression gate.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { beforeAll, expect, test } from "vite-plus/test";

const CORE = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(CORE, "../..");
const VP = path.join(REPO, "node_modules/.bin/vp");

beforeAll(() => {
  // Build dist from the current src so the gate reflects HEAD's shipped surface.
  // Skipped in the workspace run, where the root `globalSetup` has already done
  // it: `vp pack` empties `dist/` first, and doing that here deleted artefacts
  // that suites in other (parallel) projects were importing.
  if (process.env.UWK_DISTS_BUILT === "1") return;
  execFileSync(VP, ["pack"], { cwd: CORE, stdio: "ignore" });
}, 180_000);

/** Semantic diagnostics for a fixture using source or bundled declarations. */
function diagnoseAgainstCore(body: string, entry: "src" | "dist" = "dist"): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-shipped-types-"));
  // Keep the consumer isolated from workspace development export conditions.
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  symlinkSync(path.join(CORE, entry), path.join(dir, "core-dist"));
  symlinkSync(path.join(REPO, "node_modules/binaryen"), path.join(dir, "node_modules/binaryen"));
  const file = path.join(dir, "fixture.ts");
  const fixture = `import { state } from "./core-dist/index.mjs";\n${body}\n`;
  writeFileSync(file, entry === "src" ? fixture.replaceAll(".mjs", ".ts") : fixture);
  const program = ts.createProgram({
    rootNames: [file],
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      lib: ["lib.es2023.d.ts"],
    },
  });
  const sf = program.getSourceFiles().find((s) => s.fileName.endsWith("/fixture.ts"));
  if (!sf) throw new Error("fixture not in program");
  const msgs = program
    .getSemanticDiagnostics(sf)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  rmSync(dir, { recursive: true, force: true });
  return msgs;
}

test("shipped dist carries the Node chain-method API (README + .uwk.ts lowering depend on it)", () => {
  const msgs = diagnoseAgainstCore(
    `const n = state.f32(0).read();
export const r = [n.add(1), n.sub(1), n.mul(2), n.div(2), n.mod(1), n.neg(), n.eq(0), n.sin()];`,
  );
  expect(msgs).toEqual([]);
});

test("shipped dist carries the simd method surface (lane / loadVec / storeVec)", () => {
  const msgs = diagnoseAgainstCore(
    `import { addVec, splat, vec4 } from "./core-dist/simd.mjs";
const v = addVec(vec4(1, 2, 3, 4), splat(1));
const buf = state.buffer.f32({ size: 8 });
export const lane = v.lane(0);
export const loaded = buf.loadVec(0);
export function store(): void { buf.storeVec(4, v); }`,
  );
  expect(msgs).toEqual([]);
});

const UNARY_OPERATORS = [
  "neg",
  "sin",
  "cos",
  "tan",
  "tanh",
  "exp",
  "log",
  "sqrt",
  "abs",
  "floor",
  "ceil",
  "frac",
] as const;

test.each(["src", "dist"] as const)(
  "%s unary primitives preserve typed operands and fix number-only results to f32",
  (entry) => {
    const body = `import { ${UNARY_OPERATORS.join(", ")}, f32, f64, i32, i64, type Node } from "./core-dist/index.mjs";
${UNARY_OPERATORS.map(
  (op) => `
const ${op}Literal: Node<"f32"> = ${op}(7);
const ${op}F32: Node<"f32"> = ${op}(f32(7));
const ${op}F64: Node<"f64"> = ${op}(f64(7));
const ${op}ExplicitF32: Node<"f32"> = ${op}<"f32">(7);
const ${op}ExplicitF64: Node<"f64"> = ${op}<"f64">(f64(7));
// @ts-expect-error number operands produce f32, regardless of result context
const ${op}WrongContext: Node<"f64"> = ${op}(7);
// @ts-expect-error explicit type arguments cannot turn a number into f64
const ${op}WrongExplicit: Node<"f64"> = ${op}<"f64">(7);
// @ts-expect-error storing a number-only result cannot select the operand type
state.f64(0).write(${op}(7));
declare const ${op}Union: Node<"f64"> | number;
const ${op}UnionResult: Node<"f64"> | Node<"f32"> = ${op}(${op}Union);
// @ts-expect-error a union operand can produce f32
const ${op}WrongUnion: Node<"f64"> = ${op}(${op}Union);
function ${op}Generic<T extends "f32" | "f64">(value: Node<T>): Node<T> {
  return ${op}(value);
}
`,
).join("\n")}
${["abs", "neg"]
  .map(
    (op) => `
const ${op}I32: Node<"i32"> = ${op}(i32(-7));
const ${op}I64: Node<"i64"> = ${op}(i64(-7n));
const ${op}ExplicitI32: Node<"i32"> = ${op}<"i32">(i32(-7));
// @ts-expect-error number-only results cannot claim integer division
const ${op}WrongI32: Node<"i32"> = ${op}(-7);
// @ts-expect-error an integer type argument cannot change runtime literal lifting
const ${op}WrongExplicitI32: Node<"i32"> = ${op}<"i32">(-7);
// @ts-expect-error f32 results cannot be stored in integer state
state.i32(0).write(${op}(-7));
`,
  )
  .join("\n")}`;
    expect(diagnoseAgainstCore(body, entry)).toEqual([]);
  },
);
