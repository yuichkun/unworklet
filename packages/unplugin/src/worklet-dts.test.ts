/**
 * Behavior of the per-file `?worklet` type witness (`workletDts`). Black-box: a
 * throwaway consumer type-checks the marquee import — `import x from
 * "./gain.processor.ts?worklet"` — with stock TypeScript, the wildcard client
 * reference AND the emitted per-file witness both in scope. The specific witness
 * must win, so `node.params.<declared>` types as an AudioParam and an undeclared
 * name is an error; without the witness the wildcard's `unknown` keeps the
 * permissive `Record`.
 *
 * The witness is built from a REAL compiled processor's WorkletNamespace (the
 * same object the plugin evaluates for `compile`), so the names are the ones the
 * declarations actually produce — not a hand-written fixture.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  audioOutput,
  defineProcessor,
  event,
  f32,
  forSample,
  param,
  select,
  state,
} from "@unworklet/core";
import ts from "typescript";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { workletDts } from "./worklet-dts.ts";

const UNPLUGIN = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(UNPLUGIN, "../..");
const CORE = path.join(REPO, "packages/core");

// A real processor: one named param `gain`, stereo output `main`.
const gainProc = defineProcessor(() => {
  const g = param.f32({ default: 1, min: 0, max: 4, automationRate: "a-rate" }).named("gain");
  const out = audioOutput({ channels: 2, name: "main" });
  return {
    process: () => {
      forSample((i) => {
        out.left.at(i).write(g.at(i));
      });
    },
  };
});

const SPECIFIER = "*/gain.processor.ts?worklet";

const USAGE = (tail: string): string =>
  `/// <reference types="@unworklet/unplugin/client" />
/// <reference path="./gain.worklet.d.ts" />
import { createNode } from "@unworklet/core";
import gain from "./gain.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const node = await createNode(ctx, gain);
${tail}
}
`;

// A second real processor that exercises `event` payload types in both
// directions: `setGain` is a `from: 'main'` message (main-side `.emit(payload)`),
// `meter` is a `to: 'main'` event (main-side `.on(handler)`). The worklet body
// consumes `on` in a `select` cond so the per-field wire seal fires (declared
// `boolean` → bool wire); the witness must reflect the declared shape.
const eventProc = defineProcessor(() => {
  const setGain = event<{ gain: number; on: boolean }>({ from: "main", name: "setGain" });
  const meter = event<{ level: number }>({ to: "main", name: "meter" });
  const gainState = state.f32(0);
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      setGain.onReceive(({ gain, on }) => {
        gainState.write(select(on, gain, f32(0)));
      });
      forSample((i) => {
        const v = gainState.read();
        out.ch(0).at(i).write(v);
        meter.emitIf(true, { level: v });
      });
    },
  };
});

const EVENT_USAGE = (tail: string): string =>
  `/// <reference types="@unworklet/unplugin/client" />
/// <reference path="./event.worklet.d.ts" />
import { createNode } from "@unworklet/core";
import proc from "./event.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
${tail}
}
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "uwk-worklet-dts-"));
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

  // The per-file witness the plugin emits for this processor file.
  writeFileSync(path.join(dir, "gain.worklet.d.ts"), workletDts(SPECIFIER, gainProc.worklet));

  writeFileSync(
    path.join(dir, "typed.ts"),
    USAGE("  node.params.gain.value = 0.5;\n  node.outputs.main.connect(ctx.destination);"),
  );
  writeFileSync(path.join(dir, "undeclared.ts"), USAGE("  void node.params.notAParam;"));
  writeFileSync(path.join(dir, "undeclared-output.ts"), USAGE("  void node.outputs.nope;"));

  // Second witness: events with typed payloads. Same directory / tsconfig.
  writeFileSync(
    path.join(dir, "event.worklet.d.ts"),
    workletDts("*/event.processor.ts?worklet", eventProc.worklet),
  );
  writeFileSync(
    path.join(dir, "event-typed-emit.ts"),
    EVENT_USAGE("  node.events.setGain.emit({ gain: 0.8, on: true });"),
  );
  writeFileSync(
    path.join(dir, "event-wrong-emit-num.ts"),
    EVENT_USAGE('  node.events.setGain.emit({ gain: "wrong", on: true });'),
  );
  writeFileSync(
    path.join(dir, "event-wrong-emit-bool.ts"),
    EVENT_USAGE('  node.events.setGain.emit({ gain: 0.8, on: "wrong" });'),
  );
  writeFileSync(
    path.join(dir, "event-typed-on.ts"),
    EVENT_USAGE("  node.events.meter.on((e) => { void e.level.toFixed(2); });"),
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

test("the per-file witness types node.params.<declared> as an AudioParam", () => {
  expect(diagnose("typed.ts")).toEqual([]);
});

test("the per-file witness rejects an undeclared param name", () => {
  const msgs = diagnose("undeclared.ts");
  expect(msgs.some((m) => /notAParam/.test(m) && /does not exist/.test(m))).toBe(true);
});

test("the per-file witness also types node.outputs.<name> and rejects an undeclared output", () => {
  expect(diagnose("typed.ts")).toEqual([]); // node.outputs.main now resolves
  const msgs = diagnose("undeclared-output.ts");
  expect(msgs.some((m) => /nope/.test(m) && /does not exist/.test(m))).toBe(true);
});

// Event payload types recovered from the emitted witness. Same shape check as
// params/outputs: a valid call passes silently, a wrong-typed field errors.
test("the per-file witness types node.events.<name>.emit payload from declared fields", () => {
  expect(diagnose("event-typed-emit.ts")).toEqual([]);
});

test("the per-file witness rejects a wrong-typed number field on emit", () => {
  const msgs = diagnose("event-wrong-emit-num.ts");
  expect(msgs.some((m) => /string.*not assignable.*number/is.test(m))).toBe(true);
});

test("the per-file witness rejects a wrong-typed boolean field on emit", () => {
  const msgs = diagnose("event-wrong-emit-bool.ts");
  expect(msgs.some((m) => /string.*not assignable.*boolean/is.test(m))).toBe(true);
});

test("the per-file witness types the .on handler payload from declared fields", () => {
  expect(diagnose("event-typed-on.ts")).toEqual([]);
});

// Unit test of the direction-marker emission (the string the witness writes),
// driven by a minimal namespace so it covers the marker logic — including the
// same-name in/out pair — without depending on event DSL plumbing.
test("the witness marks event direction: eventRings → out, messageRings → in, a same-name pair → inout", () => {
  const ns = {
    initialize: () => {},
    process: () => true,
    parameterDescriptors: [],
    publishSlots: [],
    eventRings: [{ name: "peak" }, { name: "both" }],
    messageRings: [{ name: "ctrl" }, { name: "both" }],
    midiRings: [],
    inputs: [],
    outputs: [],
  } as unknown as Parameters<typeof workletDts>[1];
  const dts = workletDts("*/x.processor.ts?worklet", ns);
  expect(dts).toContain('"peak": { dir: "out"; fields: {} }');
  expect(dts).toContain('"ctrl": { dir: "in"; fields: {} }');
  expect(dts).toContain('"both": { dir: "inout"; fields: {} }');
});
