/**
 * The aggregate witness types EVERY processor in one file: two processors with
 * distinct params, one `workletsDts` output referenced once, both `?worklet`
 * imports typed and an undeclared name on either still an error. Black-box
 * against stock TypeScript — the consumer references a single generated d.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { audioOutput, defineProcessor, forSample, param } from "@unworklet/core";
import ts from "typescript";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { workletsDts } from "./worklet-dts.ts";

const UNPLUGIN = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(UNPLUGIN, "../..");
const CORE = path.join(REPO, "packages/core");

const makeProc = (paramName: string) =>
  defineProcessor(() => {
    const p = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named(paramName);
    const out = audioOutput({ channels: 2, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.left.at(i).write(p.at(i));
        });
      },
    };
  });

const USAGE = (tail: string): string =>
  `/// <reference types="@unworklet/unplugin/client" />
/// <reference path="./worklets.d.ts" />
import { createNode } from "@unworklet/core";
import gain from "./gain.processor.ts?worklet";
import cutoff from "./cutoff.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const gnode = await createNode(ctx, gain);
  const cnode = await createNode(ctx, cutoff);
${tail}
}
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "uwk-worklets-multi-"));
  mkdirSync(path.join(dir, "node_modules/@unworklet"), { recursive: true });
  symlinkSync(UNPLUGIN, path.join(dir, "node_modules/@unworklet/unplugin"));
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
  // One generated file for both processors.
  writeFileSync(
    path.join(dir, "worklets.d.ts"),
    workletsDts([
      { source: "/proj/gain.processor.ts", ns: makeProc("gain").worklet },
      { source: "/proj/cutoff.processor.ts", ns: makeProc("cutoff").worklet },
    ]),
  );
  writeFileSync(
    path.join(dir, "typed.ts"),
    USAGE("  gnode.params.gain.value = 0.5;\n  cnode.params.cutoff.value = 0.5;"),
  );
  writeFileSync(path.join(dir, "undeclared.ts"), USAGE("  void cnode.params.notAParam;"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Semantic diagnostic message texts for a single fixture file. */
function diagnose(fixture: string): string[] {
  const read = ts.readConfigFile(path.join(dir, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir);
  const file = path.join(dir, fixture);
  const program = ts.createProgram({ rootNames: [file], options: parsed.options });
  const sf = program.getSourceFiles().find((s) => s.fileName.endsWith(`/${fixture}`));
  if (!sf) throw new Error(`fixture not in program: ${fixture}`);
  return program
    .getSemanticDiagnostics(sf)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("the aggregate witness types every processor's params", () => {
  expect(diagnose("typed.ts")).toEqual([]);
});

test("an undeclared param on the second processor still errors", () => {
  const msgs = diagnose("undeclared.ts");
  expect(msgs.some((m) => /notAParam/.test(m) && /does not exist/.test(m))).toBe(true);
});
