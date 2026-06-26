/**
 * Behavior of the main-thread node handle's typed surface (`node.params.<name>`).
 * Black-box: a throwaway consumer resolves `@unworklet/core` through its
 * `development` export condition (src, no build) and type-checks fixtures with
 * stock TypeScript — asserting the diagnostics a real editor / `tsc` surfaces.
 *
 * A processor whose compiled type carries a param-name map must type
 * `node.params.<declared>` as an AudioParam and REJECT an undeclared name; a
 * processor with an unknown witness (the current `?worklet` default) keeps the
 * permissive `Record<string, AudioParam>` so existing code is unaffected.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const CORE = path.resolve(import.meta.dirname, "..");

const PRELUDE = `import type { CompiledProcessor } from "@unworklet/core";
import { createNode } from "@unworklet/core";
declare const ctx: BaseAudioContext;`;

let dir: string;

beforeAll(() => {
  // A throwaway consumer: node_modules symlinks to the real core so the package
  // `exports` (development condition → src) does the resolution, no build.
  dir = mkdtempSync(path.join(tmpdir(), "uwk-node-types-"));
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

  // A processor whose compiled witness carries a param-name map.
  writeFileSync(
    path.join(dir, "typed-param.ts"),
    `${PRELUDE}
declare const proc: CompiledProcessor<{ params: { gain: "f32" } }>;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
  node.params.gain.value = 0.5;
}
`,
  );

  // Same processor — an undeclared param name must be a type error.
  writeFileSync(
    path.join(dir, "undeclared-param.ts"),
    `${PRELUDE}
declare const proc: CompiledProcessor<{ params: { gain: "f32" } }>;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
  void node.params.notAParam;
}
`,
  );

  // The current `?worklet` default (unknown witness) keeps the permissive map.
  writeFileSync(
    path.join(dir, "unknown-witness.ts"),
    `${PRELUDE}
declare const proc: CompiledProcessor<unknown>;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
  node.params.anything.value = 1;
}
`,
  );

  // `UnworkletNode<typeof processorImport>` — naming the node handle's type
  // straight off a `?worklet` import (a `CompiledProcessor<config>`), without a
  // `createNode` round-trip. The same per-processor surface must resolve, so the
  // type argument accepts the processor itself, not just its inner config.
  writeFileSync(
    path.join(dir, "node-from-processor.ts"),
    `${PRELUDE}
import type { UnworkletNode } from "@unworklet/core";
declare const proc: CompiledProcessor<{
  params: { gain: "f32" };
  state: { level: "f32" };
  events: { tick: unknown };
  midi: { keys: unknown };
  inputs: { main: unknown };
  outputs: { main: unknown };
}>;
declare const node: UnworkletNode<typeof proc>;
export function f(): void {
  node.params.gain.value = 0.5;
  node.state.level.subscribe(() => {});
  node.events.tick.on(() => {});
  node.midi.keys.send({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
  node.outputs.main.connect(ctx.destination);
  void node.inputs.main;
  // @ts-expect-error undeclared param name
  void node.params.nope;
  // @ts-expect-error undeclared state name
  void node.state.nope;
}
`,
  );

  // Every surface — params / state / events / midi / inputs / outputs — keyed by
  // the declared names: each declared member usable, each undeclared one an error.
  writeFileSync(
    path.join(dir, "all-surfaces.ts"),
    `${PRELUDE}
declare const proc: CompiledProcessor<{
  params: { gain: "f32" };
  state: { level: "f32" };
  events: { tick: unknown };
  midi: { keys: unknown };
  inputs: { main: unknown };
  outputs: { main: unknown };
}>;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
  node.params.gain.value = 0.5;
  node.state.level.subscribe(() => {});
  node.events.tick.on(() => {});
  node.midi.keys.send({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
  node.outputs.main.connect(ctx.destination);
  void node.inputs.main;
  // @ts-expect-error undeclared state name
  void node.state.nope;
  // @ts-expect-error undeclared midi name
  void node.midi.nope;
  // @ts-expect-error undeclared input name
  void node.inputs.nope;
}
`,
  );
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

test("a declared param name types node.params.<name> as an AudioParam", () => {
  expect(diagnose("typed-param.ts")).toEqual([]);
});

test("an undeclared param name is a type error", () => {
  const msgs = diagnose("undeclared-param.ts");
  expect(msgs.some((m) => /notAParam/.test(m) && /does not exist/.test(m))).toBe(true);
});

test("an unknown processor witness keeps the permissive param map (back-compat)", () => {
  expect(diagnose("unknown-witness.ts")).toEqual([]);
});

test("declared names across every surface are typed; undeclared names error", () => {
  expect(diagnose("all-surfaces.ts")).toEqual([]);
});

test("UnworkletNode<typeof processorImport> resolves the per-processor surface directly", () => {
  expect(diagnose("node-from-processor.ts")).toEqual([]);
});
