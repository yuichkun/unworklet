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
  i64,
  forSample,
  param,
  select,
  state,
} from "@unworklet/core";
import ts from "typescript";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { workletDts } from "./worklet-dts.ts";

// The witness generator now lives in `@unworklet/lang`, but this integration
// test still needs the unplugin's `client.d.ts` (its `/// <reference types>`
// pulls the wildcard `?worklet` module ambient), so both are symlinked into the
// throwaway consumer's `node_modules`.
const LANG = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(LANG, "../..");
const CORE = path.join(REPO, "packages/core");
const UNPLUGIN = path.join(REPO, "packages/unplugin");

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
  // `level` seals to f32. `tick` is declared `number` — which `EmitPayload` lets
  // you satisfy with a `Node<"i64">` — so its wire seals to i64 and the main
  // thread receives a bigint (`DataView.getBigInt64`). The witness has to say so.
  const meter = event<{ level: number; tick: number }>({ to: "main", name: "meter" });
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
        meter.emitIf(true, { level: v, tick: i64(1n) });
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

// A same-name in/out pair (Q87): main sends `{ gain }` and receives `{ level }`
// under one name. The two directions are separate rings carrying separate
// payloads, so the witness must keep their field sets apart — merging them makes
// `.emit()` demand outbound-only fields and `.on()` promise inbound-only ones.
// Reported by @codex on #43.
const inoutProc = defineProcessor(() => {
  const ctlIn = event<{ gain: number }>({ from: "main", name: "ctl" });
  const ctlOut = event<{ level: number }>({ to: "main", name: "ctl" });
  const s = state.f32(0);
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      ctlIn.onReceive(({ gain }) => {
        s.write(gain);
      });
      forSample((i) => {
        const v = s.read();
        out.ch(0).at(i).write(v);
        ctlOut.emitIf(true, { level: v });
      });
    },
  };
});

const INOUT_USAGE = (tail: string): string =>
  `/// <reference types="@unworklet/unplugin/client" />
/// <reference path="./inout.worklet.d.ts" />
import { createNode } from "@unworklet/core";
import proc from "./inout.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
${tail}
}
`;

// A third real processor that exercises `state.expose({ publish })` on multiple
// scalar types (f32 / i32 / bool). Each published slot must reach the main-side
// `.value` / `.subscribe(handler)` typed to its DECLARED scalar — before this
// fix the witness carried `"f32"` etc. but the client type erased it to
// `unknown`, so `.value` was `unknown` and a handler had to `as unknown as
// number` cast. Guidance-dogfood F-09-state.
const stateProc = defineProcessor(() => {
  const meter = state
    .f32(0)
    .named("meter")
    .expose({ publish: { rateFps: 30 } });
  const stepIdx = state
    .i32(0)
    .named("stepIdx")
    .expose({ publish: { rateFps: 30 } });
  const running = state
    .bool(false)
    .named("running")
    .expose({ publish: { rateFps: 30 } });
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      forSample((i) => {
        out.ch(0).at(i).write(meter.read());
        stepIdx.write(i);
        running.write(true);
      });
    },
  };
});

const STATE_USAGE = (tail: string): string =>
  `/// <reference types="@unworklet/unplugin/client" />
/// <reference path="./state.worklet.d.ts" />
import { createNode } from "@unworklet/core";
import proc from "./state.processor.ts?worklet";
declare const ctx: BaseAudioContext;
export async function f(): Promise<void> {
  const node = await createNode(ctx, proc);
${tail}
}
`;

// A fourth real processor that exercises `event.midi(...)` on both directions:
// `keys` receives MIDI from main (main should be able to `.send(...)` and
// `.connectFromWebMIDI(...)`); `arpOut` sends MIDI to main (main should
// `.onEvent(...)`). Wrong-direction methods must be narrowed away by
// `MidiPortSurfaceFor<D>` (guidance-dogfood Round 2 gap 3).
const midiProc = defineProcessor(() => {
  const keys = event.midi({ from: "main", name: "keys" });
  const arpOut = event.midi({ to: "main", name: "arpOut" });
  const out = audioOutput({ channels: 1, name: "main" });
  return {
    process: () => {
      keys.onEvent("noteOn", () => {});
      forSample((i) => {
        out.ch(0).at(i).write(f32(0));
        arpOut.emitIf(false, { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: i });
      });
    },
  };
});

const MIDI_USAGE = (tail: string): string =>
  `/// <reference types="@unworklet/unplugin/client" />
/// <reference path="./midi.worklet.d.ts" />
import { createNode } from "@unworklet/core";
import proc from "./midi.processor.ts?worklet";
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
  // An i64 field arrives as a bigint, so `.toString()` is available …
  writeFileSync(
    path.join(dir, "event-i64-on.ts"),
    EVENT_USAGE("  node.events.meter.on((e) => { void e.tick.toString(); });"),
  );
  // … and `.toFixed` is not. Typing i64 as `number` would let this compile and
  // then throw at runtime, which is the regression this pins.
  writeFileSync(
    path.join(dir, "event-i64-wrong.ts"),
    EVENT_USAGE("  node.events.meter.on((e) => { void e.tick.toFixed(2); });"),
  );

  // Same-name in/out pair: each direction keeps its own payload.
  writeFileSync(
    path.join(dir, "inout.worklet.d.ts"),
    workletDts("*/inout.processor.ts?worklet", inoutProc.worklet),
  );
  writeFileSync(
    path.join(dir, "inout-emit.ts"),
    INOUT_USAGE("  node.events.ctl.emit({ gain: 0.8 });"),
  );
  writeFileSync(
    path.join(dir, "inout-on.ts"),
    INOUT_USAGE("  node.events.ctl.on((e) => { void e.level.toFixed(2); });"),
  );
  // `gain` travels main → worklet only, so it is never in a delivered payload.
  writeFileSync(
    path.join(dir, "inout-on-wrong.ts"),
    INOUT_USAGE("  node.events.ctl.on((e) => { void e.gain; });"),
  );

  // Third witness: state.expose({ publish }) on f32 / i32 / bool. Same dir / tsconfig.
  writeFileSync(
    path.join(dir, "state.worklet.d.ts"),
    workletDts("*/state.processor.ts?worklet", stateProc.worklet),
  );
  writeFileSync(
    path.join(dir, "state-typed-subscribe.ts"),
    STATE_USAGE(
      "  node.state.meter.subscribe((v) => { void v.toFixed(2); });\n" +
        "  node.state.stepIdx.subscribe((v) => { void v.toString(10); });\n" +
        "  node.state.running.subscribe((v) => { void !v; });\n" +
        "  void node.state.meter.value.toFixed(2);\n" +
        "  void node.state.running.value === true;",
    ),
  );
  writeFileSync(
    path.join(dir, "state-wrong-subscribe-bool.ts"),
    STATE_USAGE("  node.state.running.subscribe((v) => { void v.toFixed(2); });"),
  );
  writeFileSync(
    path.join(dir, "state-wrong-value-num.ts"),
    STATE_USAGE("  void node.state.meter.value.startsWith('x');"),
  );

  // Fourth witness: MIDI ports both directions. Same dir / tsconfig.
  writeFileSync(
    path.join(dir, "midi.worklet.d.ts"),
    workletDts("*/midi.processor.ts?worklet", midiProc.worklet),
  );
  writeFileSync(
    path.join(dir, "midi-typed-send.ts"),
    MIDI_USAGE(
      "  node.midi.keys.send({ type: 'noteOn', channel: 0, note: 60, velocity: 100 });\n" +
        "  node.midi.keys.connectFromWebMIDI({} as unknown);\n" +
        "  node.midi.arpOut.onEvent('noteOn', (e) => { void e.note; });",
    ),
  );
  writeFileSync(
    path.join(dir, "midi-wrong-onEvent-on-in.ts"),
    MIDI_USAGE("  node.midi.keys.onEvent('noteOn', () => {});"),
  );
  writeFileSync(
    path.join(dir, "midi-wrong-send-on-out.ts"),
    MIDI_USAGE("  node.midi.arpOut.send({ type: 'noteOn', channel: 0, note: 60, velocity: 100 });"),
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

// A same-name in/out pair carries two independent payloads. Merging them into one
// field map made `.emit()` demand the outbound fields and `.on()` promise the
// inbound ones. Reported by @codex on #43.
test("a same-name in/out event types each direction from its own payload", () => {
  expect(diagnose("inout-emit.ts")).toEqual([]);
  expect(diagnose("inout-on.ts")).toEqual([]);
  const msgs = diagnose("inout-on-wrong.ts");
  expect(
    msgs.some((m) => /gain/.test(m)),
    msgs.join("\n"),
  ).toBe(true);
});

// An i64 field is delivered by `DataView.getBigInt64`, i.e. a bigint. Typing it
// as `number` let `payload.tick + 1` compile and then throw at runtime — a
// "types say it works, it doesn't" breach. Reported by @codex on #43.
test("an i64 event field types as bigint, not number", () => {
  expect(diagnose("event-i64-on.ts")).toEqual([]);
  const msgs = diagnose("event-i64-wrong.ts");
  expect(
    msgs.some((m) => /toFixed/i.test(m)),
    msgs.join("\n"),
  ).toBe(true);
});

// State-publish value / subscribe types recovered from the per-slot scalar marker.
// A published `state.f32` slot's `.value` is `number` and `.subscribe(handler)`
// receives `(v: number)`; likewise `i32 → number`, `bool → boolean`.
test("the per-file witness types node.state.<name>.value and subscribe from the declared scalar", () => {
  expect(diagnose("state-typed-subscribe.ts")).toEqual([]);
});

test("the per-file witness rejects boolean-state subscribe treating the value as a number", () => {
  const msgs = diagnose("state-wrong-subscribe-bool.ts");
  expect(msgs.some((m) => /toFixed.*not exist.*boolean|boolean.*no.*toFixed/is.test(m))).toBe(true);
});

test("the per-file witness rejects f32-state .value being used as a string", () => {
  const msgs = diagnose("state-wrong-value-num.ts");
  expect(msgs.some((m) => /startsWith.*not exist.*number|number.*no.*startsWith/is.test(m))).toBe(
    true,
  );
});

// MIDI port direction — the witness records `{ dir: "in" | "out" }` per port so
// the main-side surface narrows to the methods that actually apply. An `in`
// port (from:"main") lets main `.send(...)` / `.connectFromWebMIDI(...)`;
// `.onEvent(...)` errors because main is the producer. An `out` port
// (to:"main") reverses that.
test("the per-file witness allows send/connectFromWebMIDI on an `in` MIDI port and onEvent on an `out` MIDI port", () => {
  expect(diagnose("midi-typed-send.ts")).toEqual([]);
});

test("the per-file witness rejects .onEvent on an `in` (from:'main') MIDI port", () => {
  const msgs = diagnose("midi-wrong-onEvent-on-in.ts");
  expect(msgs.some((m) => /onEvent.*not exist/is.test(m))).toBe(true);
});

test("the per-file witness rejects .send on an `out` (to:'main') MIDI port", () => {
  const msgs = diagnose("midi-wrong-send-on-out.ts");
  expect(msgs.some((m) => /send.*not exist/is.test(m))).toBe(true);
});

// Unit test of the MIDI direction emission — mirrors the event-direction test
// above, driven off a minimal namespace so it covers the marker logic without
// depending on the full MIDI DSL plumbing.
test("the witness marks MIDI port direction: `direction: 'in'` → dir:'in', `'out'` → dir:'out'", () => {
  const ns = {
    initialize: () => {},
    process: () => true,
    parameterDescriptors: [],
    publishSlots: [],
    eventRings: [],
    messageRings: [],
    midiRings: [
      { name: "keys", direction: "in" },
      { name: "arpOut", direction: "out" },
    ],
    inputs: [],
    outputs: [],
  } as unknown as Parameters<typeof workletDts>[1];
  const dts = workletDts("*/x.processor.ts?worklet", ns);
  expect(dts).toContain('"keys": { dir: "in" }');
  expect(dts).toContain('"arpOut": { dir: "out" }');
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
  // A pair carries two payloads, so it emits one field map per direction rather
  // than a merged `fields` — see the same-name in/out type test below.
  expect(dts).toContain('"both": { dir: "inout"; outFields: {}; inFields: {} }');
});
