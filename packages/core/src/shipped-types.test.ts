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

/** Semantic diagnostics for a fixture type-checked against the built `dist`. */
function diagnoseAgainstDist(body: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-shipped-types-"));
  // A published-shape view: the built dist + core's one runtime dep (binaryen).
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  symlinkSync(path.join(CORE, "dist"), path.join(dir, "core-dist"));
  symlinkSync(path.join(REPO, "node_modules/binaryen"), path.join(dir, "node_modules/binaryen"));
  const file = path.join(dir, "fixture.ts");
  writeFileSync(file, `import { state } from "./core-dist/index.mjs";\n${body}\n`);
  const program = ts.createProgram({
    rootNames: [file],
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
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
  const msgs = diagnoseAgainstDist(
    `const n = state.f32(0).read();
export const r = [n.add(1), n.sub(1), n.mul(2), n.div(2), n.mod(1), n.neg(), n.eq(0), n.sin()];`,
  );
  expect(msgs).toEqual([]);
});

test("shipped dist carries the simd method surface (lane / loadVec / storeVec)", () => {
  const msgs = diagnoseAgainstDist(
    `import { addVec, splat, vec4 } from "./core-dist/simd.mjs";
const v = addVec(vec4(1, 2, 3, 4), splat(1));
const buf = state.buffer.f32({ size: 8 });
export const lane = v.lane(0);
export const loaded = buf.loadVec(0);
export function store(): void { buf.storeVec(4, v); }`,
  );
  expect(msgs).toEqual([]);
});
