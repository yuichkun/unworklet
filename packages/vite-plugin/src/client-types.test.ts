/**
 * The consumer-facing type contract of `@unworklet/vite-plugin/client`. The
 * marquee import — `import x from "./foo.processor.ts?worklet"` — only
 * type-checks if the package ships an ambient `declare module "*?worklet"` AND
 * wires it through `exports` so a single
 * `/// <reference types="@unworklet/vite-plugin/client" />` pulls it in (the
 * same shape as `vite/client`).
 *
 * Black-box: this runs the real TypeScript module resolver over a throwaway
 * consumer project — `node_modules` symlinked to the workspace packages, the
 * package `exports` doing the resolution — and asserts the diagnostics a real
 * editor / `tsc` would surface: the module is unresolved without the reference,
 * and resolved to `CompiledProcessor<unknown>` with it.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const VITE_PLUGIN = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(VITE_PLUGIN, "../..");
const CORE = path.join(REPO, "packages/core");

let dir: string;

beforeAll(() => {
  // A throwaway consumer: node_modules symlinks to the real packages so the
  // published `exports` (not a relative path) does the resolution.
  dir = mkdtempSync(path.join(tmpdir(), "uwk-client-types-"));
  mkdirSync(path.join(dir, "node_modules/@unworklet"), { recursive: true });
  symlinkSync(VITE_PLUGIN, path.join(dir, "node_modules/@unworklet/vite-plugin"));
  symlinkSync(CORE, path.join(dir, "node_modules/@unworklet/core"));
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        // resolve @unworklet/core to its `./src` (no build needed in-repo)
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

  // ?worklet import WITH the client reference, assigned to the expected type.
  writeFileSync(
    path.join(dir, "with-ref.ts"),
    `/// <reference types="@unworklet/vite-plugin/client" />
import type { CompiledProcessor } from "@unworklet/core";
import processor from "./osc.processor.ts?worklet";
const _typed: CompiledProcessor<unknown> = processor;
void _typed;
`,
  );

  // The same reference must also type a `.uwk.ts?worklet` import — the wildcard
  // matches the specifier string, so both authoring syntaxes resolve identically.
  writeFileSync(
    path.join(dir, "with-ref-uwk.ts"),
    `/// <reference types="@unworklet/vite-plugin/client" />
import type { CompiledProcessor } from "@unworklet/core";
import processor from "./osc.uwk.ts?worklet";
const _typed: CompiledProcessor<unknown> = processor;
void _typed;
`,
  );

  // Same reference, but assigned to an incompatible type — proves the default
  // export is genuinely a CompiledProcessor, not a blanket `any` that would
  // silently swallow any assignment.
  writeFileSync(
    path.join(dir, "with-ref-strict.ts"),
    `/// <reference types="@unworklet/vite-plugin/client" />
import processor from "./osc.processor.ts?worklet";
const _wrong: string = processor;
void _wrong;
`,
  );

  // No reference — the bare ?worklet import must be unresolved.
  writeFileSync(
    path.join(dir, "no-ref.ts"),
    `import processor from "./osc.processor.ts?worklet";
void processor;
`,
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Semantic + syntactic diagnostic message texts for a single fixture file. */
function diagnose(fixture: string): string[] {
  const read = ts.readConfigFile(path.join(dir, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir);
  const file = path.join(dir, fixture);
  const program = ts.createProgram({ rootNames: [file], options: parsed.options });
  const sf = program.getSourceFiles().find((s) => s.fileName.endsWith(`/${fixture}`));
  if (!sf) throw new Error(`fixture not in program: ${fixture}`);
  return [...program.getSemanticDiagnostics(sf), ...program.getSyntacticDiagnostics(sf)].map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}

test("without the client reference, a `?worklet` import is unresolved", () => {
  const msgs = diagnose("no-ref.ts");
  expect(msgs.some((m) => /Cannot find module.*\?worklet/.test(m))).toBe(true);
});

test("with the client reference, a `?worklet` import resolves to CompiledProcessor<unknown>", () => {
  expect(diagnose("with-ref.ts")).toEqual([]);
});

test("the same client reference also types a `.uwk.ts?worklet` import", () => {
  expect(diagnose("with-ref-uwk.ts")).toEqual([]);
});

test("the `?worklet` default export is typed (CompiledProcessor), not a blanket any", () => {
  const msgs = diagnose("with-ref-strict.ts");
  expect(
    msgs.some(
      (m) => m.includes("not assignable to type 'string'") && m.includes("CompiledProcessor"),
    ),
  ).toBe(true);
});
