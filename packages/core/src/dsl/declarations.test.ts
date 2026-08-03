/**
 * Declaration helper behavior (= `01-dsl.md` §1 / §3 / §4 + `11-midi.md`
 * §1). Step 3.2 covers audioInput / audioOutput / param.f32 / param.named
 * graph registration. Step 3.4 fills `.ch(c).at(i)` reader / `.write(v)`
 * writer / `param.at(i)` AST reduction. Remaining declarations (state /
 * buffer / event / message / midi / param.expose) retain throw stubs.
 */

import { expect, test } from "vite-plus/test";

import { newCaptureContext, runCapture, unwrapAst, wrapAst } from "../compile/capture.ts";
import { audioInput, audioOutput, event, param, state } from "./declarations.ts";
import { forSample } from "./loop.ts";
import { add, gt } from "./primitives.ts";

// ─────────────────────────────────────────────────────────────────────────
// param.expose = name + snapshot policy (`01-dsl.md` §3.3 + §8.2)
// ─────────────────────────────────────────────────────────────────────────

test("`param.expose({ name, snapshot })` sets the param name + snapshot policy", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    param
      .expose({ name: "route", snapshot: "transient" })
      .f32({ default: 0, min: 0, max: 7, automationRate: "k-rate" });
  });
  expect(ctx.declarations).toEqual([
    {
      kind: "param",
      name: "route",
      type: "f32",
      default: 0,
      min: 0,
      max: 7,
      automationRate: "k-rate",
      snapshot: "transient",
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// midiInput / midiOutput = declaration register (`11-midi.md` §1)
// ─────────────────────────────────────────────────────────────────────────

test("`midiInput` / `midiOutput` outside `defineProcessor` body throw", () => {
  expect(() => event.midi({ from: "main", name: "mIn" })).toThrow(/outside `defineProcessor` body/);
  expect(() => event.midi({ to: "main", name: "mOut" })).toThrow(/outside `defineProcessor` body/);
});

test("`midiInput` / `midiOutput` register declarations with default capacity 256", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const inHandle = event.midi({ from: "main", name: "mIn" });
    const outHandle = event.midi({ to: "main", name: "mOut", capacity: 1024 });
    expect(inHandle.name).toBe("mIn");
    expect(outHandle.name).toBe("mOut");
  });
  expect(ctx.declarations).toEqual([
    { kind: "midiInput", name: "mIn", capacity: 256 },
    { kind: "midiOutput", name: "mOut", capacity: 1024 },
  ]);
});

test("`midiInput().onEvent(type, handler)` captures a midiOnEvent statement", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const midi = event.midi({ from: "main", name: "mIn" });
    midi.onEvent("noteOn", () => {});
  });
  const stmt = ctx.statements.at(-1)!;
  expect(stmt).toMatchObject({ kind: "midiOnEvent", port: "mIn", eventType: "noteOn" });
});

// ─────────────────────────────────────────────────────────────────────────
// audioInput = Step 3.2 register + Step 3.4 `.ch(c).at(i)` reader
// ─────────────────────────────────────────────────────────────────────────

test("`audioInput` outside `defineProcessor` body throws", () => {
  expect(() => audioInput({ channels: 2, name: "main" })).toThrow(/outside `defineProcessor` body/);
});

test("`audioInput({ channels, name })` registers an `audioInput` declaration", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    audioInput({ channels: 2, name: "main" });
  });
  expect(ctx.declarations).toEqual([{ kind: "audioInput", name: "main", channels: 2 }]);
});

test("`audioInput` returns a handle carrying `channels` + `name`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    expect(handle.channels).toBe(2);
    expect(handle.name).toBe("main");
  });
});

test("`audioInput` stereo handle exposes `.left` / `.right` sugar", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    expect("left" in handle).toBe(true);
    expect("right" in handle).toBe(true);
  });
});

test("`audioInput` mono handle's `.left` / `.right` throw a clear stereo-only error", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    // The `.ts` type omits `.left`/`.right` for non-stereo ports; the runtime
    // guard makes the `.uwk.ts` sugar path fail clearly instead of with an opaque
    // `undefined` TypeError. The cast reaches the guarded getters.
    const handle = audioInput({ channels: 1, name: "mono" }) as unknown as {
      left: unknown;
      right: unknown;
    };
    expect(() => handle.left).toThrow(/stereo-only/);
    expect(() => handle.right).toThrow(/stereo-only/);
  });
});

test("`audioInput.ch(c).at(node)` returns an `audioInRead` AST with the loopCounter offset", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    const read = handle.ch(0).at(i);
    expect(unwrapAst(read)).toEqual({
      kind: "audioInRead",
      portName: "main",
      channel: 0,
      offset: { kind: "loopCounter" },
    });
  });
});

test("`audioInput.ch(c).at(literal)` lifts the JS number offset to an `i32` literal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    const read = handle.ch(1).at(0);
    expect(unwrapAst(read)).toEqual({
      kind: "audioInRead",
      portName: "main",
      channel: 1,
      offset: { kind: "literal", type: "i32", value: 0 },
    });
  });
});

test("`audioInput.left.at(i)` stereo sugar produces the same AST as `.ch(0).at(i)`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    expect(unwrapAst(handle.left.at(i))).toEqual(unwrapAst(handle.ch(0).at(i)));
  });
});

test("`audioInput.right.at(i)` stereo sugar produces the same AST as `.ch(1).at(i)`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    expect(unwrapAst(handle.right.at(i))).toEqual(unwrapAst(handle.ch(1).at(i)));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// audioOutput = Step 3.2 register + Step 3.4 `.ch(c).at(i).write(v)` writer
// ─────────────────────────────────────────────────────────────────────────

test("`audioOutput` outside `defineProcessor` body throws", () => {
  expect(() => audioOutput({ channels: 2, name: "main" })).toThrow(
    /outside `defineProcessor` body/,
  );
});

test("`audioOutput({ channels, name })` registers an `audioOutput` declaration", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    audioOutput({ channels: 2, name: "main" });
  });
  expect(ctx.declarations).toEqual([{ kind: "audioOutput", name: "main", channels: 2 }]);
});

test("`audioOutput` returns a handle carrying `channels` + `name`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    expect(handle.channels).toBe(2);
    expect(handle.name).toBe("main");
  });
});

test("`audioOutput` stereo handle exposes `.left` / `.right` sugar", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    expect("left" in handle).toBe(true);
    expect("right" in handle).toBe(true);
  });
});

test("`audioOutput` mono handle's `.left` / `.right` throw a clear stereo-only error", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 1, name: "mono" }) as unknown as {
      left: unknown;
      right: unknown;
    };
    expect(() => handle.left).toThrow(/stereo-only/);
    expect(() => handle.right).toThrow(/stereo-only/);
  });
});

test("`audioOutput.ch(c).at(i).write(node)` appends an `audioOutWrite` AST to statements", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    const value = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.5 });
    handle.ch(0).at(i).write(value);
  });
  expect(ctx.statements).toEqual([
    {
      kind: "audioOutWrite",
      portName: "main",
      channel: 0,
      offset: { kind: "loopCounter" },
      value: { kind: "literal", type: "f32", value: 0.5 },
    },
  ]);
});

test("`audioOutput.ch(c).at(literal).write(literal)` lifts both literals (= i32 offset / f32 value)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 1, name: "mono" });
    handle.ch(0).at(0).write(0.25);
  });
  expect(ctx.statements).toEqual([
    {
      kind: "audioOutWrite",
      portName: "mono",
      channel: 0,
      offset: { kind: "literal", type: "i32", value: 0 },
      value: { kind: "literal", type: "f32", value: 0.25 },
    },
  ]);
});

test("`audioOutput.left.at(i).write(v)` stereo sugar has the same effect as channel 0", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    const value = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
    handle.left.at(i).write(value);
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "audioOutWrite",
    portName: "main",
    channel: 0,
  });
});

test("`audioOutput.right.at(i).write(v)` stereo sugar has the same effect as channel 1", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    const value = wrapAst<"f32">({ kind: "literal", type: "f32", value: 1 });
    handle.right.at(i).write(value);
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "audioOutWrite",
    portName: "main",
    channel: 1,
  });
});

test("`.write(v)` inside `forSample` appends to the loop body (not to top-level statements)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 1, name: "mono" });
    forSample((i) => {
      handle.ch(0).at(i).write(0);
    });
  });
  expect(ctx.statements).toEqual([
    {
      kind: "forSample",
      stride: 1,
      depth: 0,
      body: [
        {
          kind: "audioOutWrite",
          portName: "mono",
          channel: 0,
          offset: { kind: "loopCounter", depth: 0 },
          value: { kind: "literal", type: "f32", value: 0 },
        },
      ],
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// param chain = Step 3.2 register + Step 3.4 `.at(i)` reader
// ─────────────────────────────────────────────────────────────────────────

test("`param.f32` outside `defineProcessor` body throws", () => {
  expect(() => param.f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })).toThrow(
    /outside `defineProcessor` body/,
  );
});

test("`param.f32(opts).named('X')` suffix chain registers a `param` declaration", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    param.f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" }).named("gain");
  });
  expect(ctx.declarations).toEqual([
    {
      kind: "param",
      name: "gain",
      type: "f32",
      default: 1.0,
      min: 0.0,
      max: 4.0,
      automationRate: "a-rate",
    },
  ]);
});

test("`param.named('X').f32(opts)` prefix chain produces the same declaration shape", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    param.named("gain").f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" });
  });
  expect(ctx.declarations).toEqual([
    {
      kind: "param",
      name: "gain",
      type: "f32",
      default: 1.0,
      min: 0.0,
      max: 4.0,
      automationRate: "a-rate",
    },
  ]);
});

test("duplicate `.named` in chain: last call wins (rightmost name is used)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    param
      .named("first")
      .f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })
      .named("final");
  });
  expect(ctx.declarations[0]?.name).toBe("final");
});

test("`param.at(node)` returns a `paramAt` AST with the loopCounter offset", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = param
      .f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })
      .named("gain");
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    expect(unwrapAst(handle.at(i))).toEqual({
      kind: "paramAt",
      paramName: "gain",
      offset: { kind: "loopCounter" },
    });
  });
});

test("`param.at(literal)` lifts the JS number offset to an `i32` literal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = param
      .f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })
      .named("gain");
    expect(unwrapAst(handle.at(0))).toEqual({
      kind: "paramAt",
      paramName: "gain",
      offset: { kind: "literal", type: "i32", value: 0 },
    });
  });
});

test("`param.at` paramName reflects the name set by the last `.named` call in the chain (late binding)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = param
      .named("first")
      .f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })
      .named("final");
    expect(unwrapAst(handle.at(0))).toMatchObject({
      kind: "paramAt",
      paramName: "final",
    });
  });
});

test("`param` handle `.expose({...})` (suffix) updates name + snapshot policy", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    param
      .f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })
      .named("gain")
      .expose({ snapshot: "transient" });
  });
  const decl = ctx.declarations[0];
  expect(decl).toMatchObject({ kind: "param", name: "gain", snapshot: "transient" });
});

// ─────────────────────────────────────────────────────────────────────────
// state plain factory = Phase 7 sub-phase 7.1 (state.<type>(initial) declares
// a scalar slot; .read() / .write(v) produce AST nodes)
// ─────────────────────────────────────────────────────────────────────────

test("`state.f32(0)` outside `defineProcessor` body throws", () => {
  expect(() => state.f32(0)).toThrow(/outside `defineProcessor` body/);
});

test("`state.f32(initial)` registers a `state` declaration with synthetic name", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0.5);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "__state_0", type: "f32", initial: 0.5, userNamed: false },
  ]);
});

test("multiple plain `state` calls produce unique synthetic names (__state_0 / __state_1 / ...)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0);
    state.i32(0);
    state.bool(false);
  });
  expect(ctx.declarations.map((d) => (d.kind === "state" ? d.name : "?"))).toEqual([
    "__state_0",
    "__state_1",
    "__state_2",
  ]);
});

test("`state.<type>(initial)` registers all 5 types (f32 / f64 / i32 / i64 / bool)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(1.5);
    state.f64(2.5);
    state.i32(7);
    state.i64(8n);
    state.bool(true);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "__state_0", type: "f32", initial: 1.5, userNamed: false },
    { kind: "state", name: "__state_1", type: "f64", initial: 2.5, userNamed: false },
    { kind: "state", name: "__state_2", type: "i32", initial: 7, userNamed: false },
    { kind: "state", name: "__state_3", type: "i64", initial: 8n, userNamed: false },
    { kind: "state", name: "__state_4", type: "bool", initial: true, userNamed: false },
  ]);
});

test("`state.f32(0).read()` eager-captures a `stateLoad` (tied to decl.name) and returns a `tempRef`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    // load() freezes the read into a temp local (issue #8): it returns a
    // tempRef, and the stateLoad lives in the recorded tempAssign statement.
    expect(unwrapAst(z.read())).toEqual({ kind: "tempRef", tempId: 0, type: "f32" });
    expect(ctx.statements.at(-1)).toMatchObject({
      kind: "tempAssign",
      valueType: "f32",
      value: { kind: "stateLoad", type: "f32", name: "__state_0" },
    });
  });
});

test("`state.f32(0).write(Node)` appends a `stateStore` AST to statements", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    const v = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.5 });
    z.write(v);
  });
  expect(ctx.statements).toEqual([
    {
      kind: "stateStore",
      type: "f32",
      name: "__state_0",
      value: { kind: "literal", type: "f32", value: 0.5 },
    },
  ]);
});

test("`state.f32(0).write(literal)` lifts JS number to `f32` literal AST", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    z.write(0.25);
  });
  expect(ctx.statements).toEqual([
    {
      kind: "stateStore",
      type: "f32",
      name: "__state_0",
      value: { kind: "literal", type: "f32", value: 0.25 },
    },
  ]);
});

test("`state.i32(0).write(literal)` lifts JS number to `i32` literal AST", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.i32(0);
    z.write(42);
  });
  expect(ctx.statements).toEqual([
    {
      kind: "stateStore",
      type: "i32",
      name: "__state_0",
      value: { kind: "literal", type: "i32", value: 42 },
    },
  ]);
});

test("`state.bool(false).write(true)` lifts boolean to internal i32 (= 0/1) literal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const flag = state.bool(false);
    flag.write(true);
  });
  expect(ctx.statements).toEqual([
    {
      kind: "stateStore",
      type: "bool",
      name: "__state_0",
      value: { kind: "literal", type: "i32", value: 1 },
    },
  ]);
});

test("`state.bool(false).write(false)` lifts boolean to internal i32 0 literal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const flag = state.bool(true);
    flag.write(false);
  });
  expect(ctx.statements[0]).toEqual({
    kind: "stateStore",
    type: "bool",
    name: "__state_0",
    value: { kind: "literal", type: "i32", value: 0 },
  });
});

test("`state.i64(0n).write(bigint literal)` captures an `i64` literal AST", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.i64(0n);
    z.write(42n);
  });
  expect(ctx.statements).toEqual([
    {
      kind: "stateStore",
      type: "i64",
      name: "__state_0",
      value: { kind: "literal", type: "i64", value: 42n },
    },
  ]);
});

test("`state.named('X').f32(0)` prefix chain registers with name `X`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.named("meterL").f32(0);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "meterL", type: "f32", initial: 0, userNamed: true },
  ]);
});

test("`state.f32(0).named('X')` suffix chain mutates decl.name (same declaration shape)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0).named("meterL");
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "meterL", type: "f32", initial: 0, userNamed: true },
  ]);
});

test("duplicate `.named` in chain: last call wins (rightmost name is used)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.named("first").f32(0).named("final");
  });
  expect(ctx.declarations[0]?.name).toBe("final");
});

test("`state.<type>.read()` name reflects the final `.named` value in the chain (late binding)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = state.named("orig").f32(0).named("final");
    // The eager-captured stateLoad (inside the tempAssign) reflects the
    // late-bound final name; read() itself returns a tempRef.
    expect(unwrapAst(handle.read())).toEqual({ kind: "tempRef", tempId: 0, type: "f32" });
    expect(ctx.statements.at(-1)).toMatchObject({
      kind: "tempAssign",
      value: { kind: "stateLoad", type: "f32", name: "final" },
    });
  });
});

test("`state.<type>.write(v)` name also reflects the final `.named` value (late binding)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = state.f32(0).named("final");
    handle.write(0);
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "stateStore",
    name: "final",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// state.expose chain = sub-phase 7.2 (`.named` / `.expose({...})` chain sets
// name / snapshot / publish metadata on the declaration; graph-capture-time
// checks reject: publish + unsupported type, publish without name, snapshot
// 'persistent' without name, publish rateFps <= 0)
// ─────────────────────────────────────────────────────────────────────────

test("`state.expose({ name }).f32(0)` prefix chain sets name + userNamed true on the declaration", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.expose({ name: "meterL" }).f32(0);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "meterL", type: "f32", initial: 0, userNamed: true },
  ]);
});

test("`state.f32(0).expose({ name })` suffix chain mutates decl name + userNamed", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0).expose({ name: "meterL" });
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "meterL", type: "f32", initial: 0, userNamed: true },
  ]);
});

test("`state.named('A').expose({ name: 'B' }).f32(0)` = after-wins (= 'B')", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.named("A").expose({ name: "B" }).f32(0);
  });
  expect(ctx.declarations[0]?.name).toBe("B");
});

test("`state.expose({ name: 'A' }).named('B').f32(0)` = after-wins (= 'B')", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.expose({ name: "A" }).named("B").f32(0);
  });
  expect(ctx.declarations[0]?.name).toBe("B");
});

test("`state.expose({ name, snapshot, publish }).f32(0)` sets all fields in one call", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } }).f32(0);
  });
  expect(ctx.declarations).toEqual([
    {
      kind: "state",
      name: "meterL",
      type: "f32",
      initial: 0,
      userNamed: true,
      snapshot: "transient",
      publish: { rateFps: 30 },
    },
  ]);
});

test("`state.f32(0).expose({...})` suffix reflects snapshot + publish on the declaration", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0).expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } });
  });
  expect(ctx.declarations[0]).toMatchObject({
    name: "meterL",
    userNamed: true,
    snapshot: "transient",
    publish: { rateFps: 30 },
  });
});

test("multiple `.expose` calls in chain merge fields (last write wins)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state
      .expose({ name: "x" })
      .expose({ publish: { rateFps: 30 } })
      .f32(0);
  });
  expect(ctx.declarations[0]).toMatchObject({
    name: "x",
    userNamed: true,
    publish: { rateFps: 30 },
  });
});

test("second `.expose({ publish: { rateFps: 60 } })` overwrites first `.expose({ publish: { rateFps: 30 } })`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state
      .expose({ name: "x", publish: { rateFps: 30 } })
      .expose({ publish: { rateFps: 60 } })
      .f32(0);
  });
  expect(ctx.declarations[0]).toMatchObject({
    publish: { rateFps: 60 },
  });
});

test("`state.expose({}).f32(0)` with empty options is equivalent to a plain factory (synthetic name + userNamed false)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.expose({}).f32(0);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "__state_0", type: "f32", initial: 0, userNamed: false },
  ]);
});

test("publish + unsupported type (f64) is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: 30 } }).f64(0);
    }),
  ).toThrow(/publish is only supported on state\.f32 \/ state\.i32 \/ state\.bool/);
});

test("publish + unsupported type (i64) is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: 30 } }).i64(0n);
    }),
  ).toThrow(/publish is only supported on state\.f32 \/ state\.i32 \/ state\.bool/);
});

test("publish + f32 + userNamed = OK", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: 30 } }).f32(0);
    }),
  ).not.toThrow();
});

test("publish + i32 + userNamed = OK", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: 30 } }).i32(0);
    }),
  ).not.toThrow();
});

test("publish + bool + userNamed = OK", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: 30 } }).bool(false);
    }),
  ).not.toThrow();
});

test("publish without a user-defined name is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ publish: { rateFps: 30 } }).f32(0);
    }),
  ).toThrow(/state slot with publish requires user-defined name/);
});

test("publish rateFps 0 = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: 0 } }).f32(0);
    }),
  ).toThrow(/publish rateFps must be a positive finite number/);
});

test("publish rateFps negative value = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: -1 } }).f32(0);
    }),
  ).toThrow(/publish rateFps must be a positive finite number/);
});

test("publish rateFps NaN = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: Number.NaN } }).f32(0);
    }),
  ).toThrow(/publish rateFps must be a positive finite number/);
});

test("snapshot 'persistent' + userNamed = OK", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", snapshot: "persistent" }).f32(0);
    }),
  ).not.toThrow();
});

test("snapshot 'persistent' without a user-defined name is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ snapshot: "persistent" }).f32(0);
    }),
  ).toThrow(/state slot with snapshot 'persistent' requires user-defined name/);
});

test("snapshot 'transient' without a user-defined name = OK (equivalent to plain factory)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ snapshot: "transient" }).f32(0);
    }),
  ).not.toThrow();
});

test("handle.expose suffix reflects publish and runs validation", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const h = state.f32(0).named("meterL");
    h.expose({ publish: { rateFps: 30 } });
  });
  expect(ctx.declarations[0]).toMatchObject({
    name: "meterL",
    userNamed: true,
    publish: { rateFps: 30 },
  });
});

test("handle.expose suffix with publish + synthetic name is rejected", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const h = state.f32(0);
      h.expose({ publish: { rateFps: 30 } });
    }),
  ).toThrow(/state slot with publish requires user-defined name/);
});

test("handle.expose suffix overwriting name mutates the declaration and runs duplicate collision check", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const h = state.f32(0);
    h.expose({ name: "x" });
  });
  expect(ctx.declarations[0]).toMatchObject({ name: "x", userNamed: true });
});

test("handle.expose suffix renaming to a name already used by another state is rejected", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("first").f32(0);
      const h = state.f32(0);
      h.expose({ name: "first" });
    }),
  ).toThrow(/duplicate state declaration name "first"/);
});

test("`state.write(v)` inside `forSample` appends to the loop body", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    forSample(() => {
      z.write(0.5);
    });
  });
  expect(ctx.statements).toEqual([
    {
      kind: "forSample",
      stride: 1,
      depth: 0,
      body: [
        {
          kind: "stateStore",
          type: "f32",
          name: "__state_0",
          value: { kind: "literal", type: "f32", value: 0.5 },
        },
      ],
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// buffer declaration = `buffer.<type>({ size })` + .named / .expose chain
// (`01-dsl.md` §3.2). read / write / readInterpolated behavior is tested as
// a black box in `../__tests__/behavior/buffer.test.ts`; this file covers
// declaration, chain, and validation.
// ─────────────────────────────────────────────────────────────────────────

test("`state.buffer.f32({ size })` registers a `buffer` declaration with synthetic name", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.buffer.f32({ size: 64 });
  });
  expect(ctx.declarations).toEqual([
    {
      kind: "buffer",
      name: "__buffer_0",
      type: "f32",
      size: 64,
      userNamed: false,
      snapshot: undefined,
      publish: undefined,
    },
  ]);
});

test("`buffer.<type>({ size })` registers all 6 element types (f32 / f64 / i32 / i64 / bool / u8)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.buffer.f32({ size: 1 });
    state.buffer.f64({ size: 2 });
    state.buffer.i32({ size: 3 });
    state.buffer.i64({ size: 4 });
    state.buffer.bool({ size: 5 });
    state.buffer.u8({ size: 6 });
  });
  expect(ctx.declarations.map((d) => (d.kind === "buffer" ? `${d.type}:${d.size}` : "?"))).toEqual([
    "f32:1",
    "f64:2",
    "i32:3",
    "i64:4",
    "bool:5",
    "u8:6",
  ]);
});

test("`state.buffer.named('X').f32({ size })` prefix chain reflects the given name", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.buffer.named("ring").f32({ size: 16 });
  });
  expect(ctx.declarations).toEqual([
    {
      kind: "buffer",
      name: "ring",
      type: "f32",
      size: 16,
      userNamed: true,
      snapshot: undefined,
      publish: undefined,
    },
  ]);
});

test("`state.buffer.f32({ size }).named('X')` suffix chain produces the same declaration", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.buffer.f32({ size: 16 }).named("ring");
  });
  expect(ctx.declarations.map((d) => (d.kind === "buffer" ? d.name : "?"))).toEqual(["ring"]);
});

test("buffer name uniqueness: declaring the same name twice is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.buffer.named("dup").f32({ size: 4 });
      state.buffer.named("dup").i32({ size: 4 });
    }),
  ).toThrow(/duplicate buffer declaration name "dup"/);
});

test("buffer publish is allowed for all element types (no Q42-style type restriction)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.buffer.f64({ size: 8 }).expose({ name: "spectrum", publish: { rateFps: 30 } });
    }),
  ).not.toThrow();
});

test("buffer publish without a user-defined name = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.buffer.f32({ size: 8 }).expose({ publish: { rateFps: 30 } });
    }),
  ).toThrow(/buffer with publish requires user-defined name/);
});

test("buffer publish rateFps <= 0 = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.buffer.f32({ size: 8 }).expose({ name: "x", publish: { rateFps: 0 } });
    }),
  ).toThrow(/publish rateFps must be a positive finite number/);
});

test("buffer snapshot 'persistent' without a user-defined name = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.buffer.f32({ size: 8 }).expose({ snapshot: "persistent" });
    }),
  ).toThrow(/buffer with snapshot 'persistent' requires user-defined name/);
});

// ─────────────────────────────────────────────────────────────────────────
// state name uniqueness: declaring a state with the same name twice is
// rejected at graph-capture time (`01-dsl.md` §3.1 + Q5-b)
// ─────────────────────────────────────────────────────────────────────────

test("`state.named('x').f32(0)` declared twice is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("dup").f32(0);
      state.named("dup").f32(0);
    }),
  ).toThrow(/duplicate state declaration name "dup"/);
});

test("`state.named('x').f32(0)` + `state.named('x').i32(0)` collide even when types differ", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("dup").f32(0);
      state.named("dup").i32(0);
    }),
  ).toThrow(/duplicate state declaration name "dup"/);
});

test("`state.f32(0).named('x'); state.f32(0).named('x')` collides even with suffix naming", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.f32(0).named("dup");
      state.f32(0).named("dup");
    }),
  ).toThrow(/duplicate state declaration name "dup"/);
});

test("two plain factory calls get automatically unique synthetic names and do not collide (regression check)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.f32(0);
      state.f32(0);
    }),
  ).not.toThrow();
  expect(ctx.declarations).toHaveLength(2);
});

test("`state.f32(0).named('orig').named('final')` re-naming the same declaration does not collide", () => {
  // Re-naming the same declaration twice via .named() excludes self from the
  // collision check, so the mutation passes (the excludeDecl argument path
  // in checkStateName).
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0).named("orig").named("final");
  });
  expect(ctx.declarations[0]?.name).toBe("final");
});

test("renaming via `.named()` to a name already held by another state is rejected", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("first").f32(0);
      state.f32(0).named("first");
    }),
  ).toThrow(/duplicate state declaration name "first"/);
});

// ─────────────────────────────────────────────────────────────────────────
// `event<T>` factory + handle (= `01-dsl.md` §4.1)
// ─────────────────────────────────────────────────────────────────────────

test("`event` outside `defineProcessor` body throws", () => {
  expect(() => event({ to: "main", name: "evt" })).toThrow(/outside `defineProcessor` body/);
});

test("`event({ to: 'main', name })` registers an `event` declaration with default capacity 256", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ to: "main", name: "peak" });
  });
  expect(ctx.declarations).toEqual([
    { kind: "event", name: "peak", capacity: 256, payloadCapacity: undefined, fields: [] },
  ]);
});

test("`event({ to: 'main', name, capacity })` accepts capacity override", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ to: "main", name: "peak", capacity: 32 });
  });
  expect(ctx.declarations).toEqual([
    { kind: "event", name: "peak", capacity: 32, payloadCapacity: undefined, fields: [] },
  ]);
});

test("`event({ to: 'main', name, payloadCapacity })` accepts payloadCapacity option", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ to: "main", name: "spectrum", payloadCapacity: 4096 });
  });
  expect(ctx.declarations).toEqual([
    { kind: "event", name: "spectrum", capacity: 256, payloadCapacity: 4096, fields: [] },
  ]);
});

test("`event` returns a handle carrying `name`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = event({ to: "main", name: "peak" });
    expect(handle.name).toBe("peak");
  });
});

test("duplicate `event` name is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      event({ to: "main", name: "shared" });
      event({ to: "main", name: "shared" });
    }),
  ).toThrow(/duplicate event declaration name "shared"/);
});

test("declaring an `event` without any emitIf calls is silently OK (unused declaration)", () => {
  // `01-dsl.md` §3.4 + canonical Ex 5 grainSpawned (emit-less path).
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event<{ voice: number; pos: number }>({ to: "main", name: "grainSpawned" });
  });
  expect(ctx.declarations).toHaveLength(1);
  expect(ctx.declarations[0]).toMatchObject({ kind: "event", name: "grainSpawned", fields: [] });
});

// ─────────────────────────────────────────────────────────────────────────
// `eventDecl.emitIf` graph capture + Q71 per-field wire-type resolution
// ─────────────────────────────────────────────────────────────────────────

test("`emitIf(true, payload)` at per-block top-level appends an eventEmitIf statement", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    evt.emitIf(true, { atSample: 0, level: 0.5 });
  });
  expect(ctx.statements).toHaveLength(1);
  expect(ctx.statements[0]).toEqual({
    kind: "eventEmitIf",
    name: "peak",
    cond: { kind: "literal", type: "i32", value: 1 },
    atSample: { kind: "literal", type: "i32", value: 0 },
    fields: [
      {
        name: "level",
        wireType: "f32",
        value: { kind: "literal", type: "f32", value: 0.5 },
      },
    ],
  });
});

test("`emitIf(false, payload)` is still captured in the AST (constant folding happens in a later analysis pass)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    evt.emitIf(false, { atSample: 0, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    cond: { kind: "literal", type: "i32", value: 0 },
  });
});

test("`emitIf` inside `forSample` appends to the loop body (not to top-level statements)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    forSample(() => {
      evt.emitIf(true, { atSample: 0, level: 0.25 });
    });
  });
  // top-level statements contain only the forSample node
  expect(ctx.statements).toHaveLength(1);
  expect(ctx.statements[0]?.kind).toBe("forSample");
  // the forSample body contains the eventEmitIf
  const fs = ctx.statements[0];
  if (fs?.kind !== "forSample") throw new Error("expected forSample");
  expect(fs.body).toHaveLength(1);
  expect(fs.body[0]?.kind).toBe("eventEmitIf");
});

// ─────────────────────────────────────────────────────────────────────────
// atSample default lift (inside forSample = loopCounter / per-block top = 0)
// + user override
// ─────────────────────────────────────────────────────────────────────────

test("omitting atSample inside `forSample` lifts the loopCounter as the default", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    forSample(() => {
      evt.emitIf(true, { level: 0.5 });
    });
  });
  const fs = ctx.statements[0];
  if (fs?.kind !== "forSample") throw new Error("expected forSample");
  expect(fs.body[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "loopCounter" },
  });
});

test("omitting atSample at per-block top level lifts literal 0 as the default", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    evt.emitIf(true, { level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "literal", type: "i32", value: 0 },
  });
});

test("explicit atSample passes through as a user override inside `forSample` (number literal)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    forSample(() => {
      evt.emitIf(true, { atSample: 42, level: 0.5 });
    });
  });
  const fs = ctx.statements[0];
  if (fs?.kind !== "forSample") throw new Error("expected forSample");
  expect(fs.body[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "literal", type: "i32", value: 42 },
  });
});

test("explicit atSample Node<'i32'> passes through as a user override inside `forSample`", () => {
  // Passing an explicit sample-offset computation (not just i) preserves the override.
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    forSample(() => {
      // Passing loopCounter explicitly exercises the override path (same result
      // as the default, but via a different code path — catches regressions
      // in the explicit-override branch).
      const customI = wrapAst<"i32">({ kind: "loopCounter" });
      evt.emitIf(true, { atSample: customI, level: 0.5 });
    });
  });
  const fs = ctx.statements[0];
  if (fs?.kind !== "forSample") throw new Error("expected forSample");
  expect(fs.body[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "loopCounter" },
  });
});

test("explicit atSample at per-block top level passes through as user override (arbitrary i32 literal)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    evt.emitIf(true, { atSample: 64, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "literal", type: "i32", value: 64 },
  });
});

test("atSample with an invalid type (string) throws (invalid value rejected on the override path)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number }>({ to: "main", name: "peak" });
      // @ts-expect-error — passing a string for atSample is an invalid type
      evt.emitIf(true, { atSample: "0", level: 0.5 });
    }),
  ).toThrow(/atSample" must be Node<'i32'> or number/);
});

test("Q71: first emit site seals the field wire type (number defaults to f32)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    evt.emitIf(true, { atSample: 0, level: 0.5 });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "level", wireType: "f32" }]);
  });
});

test("Q71: subsequent emit sites with the same wire type are accepted", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    evt.emitIf(true, { atSample: 0, level: 0.5 });
    evt.emitIf(true, { atSample: 0, level: 0.25 });
  });
  expect(ctx.statements).toHaveLength(2);
});

test("Q71: wire type mismatch on a subsequent emit site is rejected at graph-capture time (event-field-type-mismatch)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number }>({ to: "main", name: "peak" });
      evt.emitIf(true, { atSample: 0, level: 0.5 });
      // second emit site passes a boolean field value → seals wireType as bool, mismatching f32
      evt.emitIf(true, { atSample: 0, level: true as unknown as number });
    }),
  ).toThrow(/event "peak" field "level" wire-type mismatch/);
});

test("Q71: dropping a sealed field on a subsequent emit site is rejected at graph-capture time (missing field)", () => {
  // First emit seals level + channel; second emit omits channel. TypeScript
  // would catch this via EmitPayload<T>, but the runtime check is the
  // canonical guard — use `as` cast to bypass TS and exercise the runtime path.
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number; channel: number }>({ to: "main", name: "peak" });
      evt.emitIf(true, { atSample: 0, level: 0.5, channel: 0 });
      (evt as unknown as { emitIf: (c: boolean, p: Record<string, unknown>) => void }).emitIf(
        true,
        { atSample: 0, level: 0.25 },
      );
    }),
  ).toThrow(/missing field\(s\) "channel"/);
});

test("Q71: introducing a new field on a subsequent emit site is rejected", () => {
  // First emit seals only level; second emit adds channel as a new field.
  // TypeScript accepts this via EmitPayload<T> (channel is part of T), so no
  // compile-time guard is needed here — the runtime check is responsible for
  // the rejection.
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number; channel: number }>({ to: "main", name: "peak" });
      (evt as unknown as { emitIf: (c: boolean, p: Record<string, unknown>) => void }).emitIf(
        true,
        { atSample: 0, level: 0.5 },
      );
      evt.emitIf(true, { atSample: 0, level: 0.25, channel: 0 });
    }),
  ).toThrow(/introduces new field "channel"/);
});

test("`emitIf` Node<'bool'> cond is unwrapped to its AST representation", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    const condNode = wrapAst<"bool">({ kind: "literal", type: "i32", value: 1 });
    evt.emitIf(condNode, { atSample: 0, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    cond: { kind: "literal", type: "i32", value: 1 },
  });
});

test("`emitIf` Node<'i32'> atSample is unwrapped to its AST representation", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    const atSampleNode = wrapAst<"i32">({ kind: "loopCounter" });
    evt.emitIf(true, { atSample: atSampleNode, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "loopCounter" },
  });
});

test("`emitIf` field value with an invalid type throws", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number }>({ to: "main", name: "peak" });
      // @ts-expect-error — passing a string as a field value is an invalid type
      evt.emitIf(true, { atSample: 0, level: "hi" });
    }),
  ).toThrow(/value must be Node<T>, number, or boolean/);
});

test("Q71: Node<'i32'> field value seals the wireType as i32", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ tick: number }>({ to: "main", name: "ticker" });
    const tickNode = wrapAst<"i32">({ kind: "loopCounter" });
    evt.emitIf(true, { atSample: 0, tick: tickNode });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "tick", wireType: "i32" }]);
  });
});

test("Q71: boolean field value seals the wireType as bool", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ flag: boolean }>({ to: "main", name: "flagger" });
    evt.emitIf(true, { atSample: 0, flag: true });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "flag", wireType: "bool" }]);
  });
});

test("Q71: number literal on a subsequent emit is lifted to the already-sealed wire type (i32)", () => {
  // First emit seals i32 via Node<'i32'>; the number literal on the second
  // emit is lifted to i32 (not the default f32) — a distinct code path from
  // the default f32 lift.
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ tick: number }>({ to: "main", name: "ticker" });
    const tickNode = wrapAst<"i32">({ kind: "loopCounter" });
    evt.emitIf(true, { atSample: 0, tick: tickNode });
    evt.emitIf(true, { atSample: 0, tick: 42 });
  });
  expect(ctx.statements[1]).toMatchObject({
    fields: [{ name: "tick", wireType: "i32", value: { kind: "literal", type: "i32", value: 42 } }],
  });
});

test("inferAstType: literal Node field value seals wireType from literal.type", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ value: number }>({ to: "main", name: "lit" });
    const litF64 = wrapAst<"f64">({ kind: "literal", type: "f64", value: 1.5 });
    evt.emitIf(true, { atSample: 0, value: litF64 });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f64" }]);
  });
});

test("inferAstType: mul Node field value seals wireType from mul.type", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ value: number }>({ to: "main", name: "muller" });
    const lhs = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.5 });
    const rhs = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.25 });
    const mulNode = wrapAst<"f32">({
      kind: "mul",
      type: "f32",
      lhs: unwrapAst(lhs),
      rhs: unwrapAst(rhs),
    });
    evt.emitIf(true, { atSample: 0, value: mulNode });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f32" }]);
  });
});

test("inferAstType: audioInRead Node field value seals wireType as f32", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const input = audioInput({ channels: 1, name: "main" });
    const evt = event<{ value: number }>({ to: "main", name: "echo" });
    evt.emitIf(true, { atSample: 0, value: input.ch(0).at(0) });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f32" }]);
  });
});

test("inferAstType: paramAt Node field value seals wireType as f32", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const gain = param.named("gain").f32({
      default: 0.5,
      min: 0,
      max: 1,
      automationRate: "a-rate",
    });
    const evt = event<{ value: number }>({ to: "main", name: "echo" });
    evt.emitIf(true, { atSample: 0, value: gain.at(0) });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f32" }]);
  });
});

test("inferAstType: stateLoad Node field value seals wireType from state.type", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.named("z").f64(0);
    const evt = event<{ value: number }>({ to: "main", name: "echo" });
    evt.emitIf(true, { atSample: 0, value: z.read() });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f64" }]);
  });
});

test("inferAstType: a statement-kind AST node in expression position throws (defensive guard)", () => {
  // Structurally unreachable from user code (statement AstNodes are not
  // wrapped with wrapAst), but the guard is exercised directly here by
  // force-wrapping a stateStore kind and passing it as a field value.
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ value: number }>({ to: "main", name: "echo" });
      const stmtAst = {
        kind: "stateStore",
        type: "i32",
        name: "bogus",
        value: { kind: "literal", type: "i32", value: 0 },
      };
      const bogusNode = wrapAst<"i32">(stmtAst as unknown as Parameters<typeof wrapAst>[0]);
      evt.emitIf(true, { atSample: 0, value: bogusNode });
    }),
  ).toThrow(/statement node 'stateStore' cannot appear in expression position/);
});

// ─────────────────────────────────────────────────────────────────────────
// state.expose suffix re-setting the same name promotes userNamed (sub-phase 7.2 remaining path)
// ─────────────────────────────────────────────────────────────────────────

test("`state.expose({ name })` re-setting the same name promotes userNamed to true", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    // Declare with a synthetic name (__state_0), then .expose with the same
    // name — this promotes the userNamed flag to true, which is required by
    // paths such as snapshot 'persistent'.
    state.f32(0).expose({ name: "__state_0", snapshot: "persistent" });
  });
  expect(ctx.declarations).toHaveLength(1);
  const decl = ctx.declarations[0];
  expect(decl).toMatchObject({
    kind: "state",
    name: "__state_0",
    userNamed: true,
    snapshot: "persistent",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// `message<T>` factory + handle + onReceive (= `01-dsl.md` §4.2)
// ─────────────────────────────────────────────────────────────────────────

test("`message` outside `defineProcessor` body throws", () => {
  expect(() => event({ from: "main", name: "msg" })).toThrow(/outside `defineProcessor` body/);
});

test("`event({ from: 'main', name })` registers a `message` declaration with default capacity 256", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ from: "main", name: "reset" });
  });
  expect(ctx.declarations).toEqual([
    { kind: "message", name: "reset", capacity: 256, payloadCapacity: undefined, fields: [] },
  ]);
});

test("`event({ from: 'main', name, capacity })` accepts capacity override", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ from: "main", name: "preset", capacity: 16 });
  });
  expect(ctx.declarations[0]).toMatchObject({
    kind: "message",
    name: "preset",
    capacity: 16,
  });
});

test("`message` returns a handle carrying `name`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = event({ from: "main", name: "preset" });
    expect(handle.name).toBe("preset");
  });
});

test("duplicate `message` name is rejected at graph-capture time", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      event({ from: "main", name: "shared" });
      event({ from: "main", name: "shared" });
    }),
  ).toThrow(/duplicate message declaration name "shared"/);
});

test("`messageDecl.onReceive(handler)` evaluates the handler at build time and pushes a `messageOnReceive` AST to statements", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const reset = event<{ slot: number }>({ from: "main", name: "reset" });
    reset.onReceive(() => {
      // no AST construction in body = empty handler
    });
  });
  expect(ctx.statements).toHaveLength(1);
  expect(ctx.statements[0]).toMatchObject({
    kind: "messageOnReceive",
    name: "reset",
    body: [],
  });
});

test("`messageDecl.onReceive` multiple registrations appear in source order in statements (Q38-c)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const reset = event<{ slot: number }>({ from: "main", name: "reset" });
    reset.onReceive(() => {});
    reset.onReceive(() => {});
  });
  expect(ctx.statements).toHaveLength(2);
  expect(ctx.statements[0]?.kind).toBe("messageOnReceive");
  expect(ctx.statements[1]?.kind).toBe("messageOnReceive");
});

test("`messageDecl.onReceive` handler argument proxies field access as Node<'f32'> (number → f32 wire)", () => {
  // When the handler destructures `({ slot }) => ...`, the framework proxies
  // the "slot" field access and returns it as a `Node<'f32'>` proxy (a declared
  // `number` rides the f32 wire so its fraction survives).
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.named("counter").f32(0);
    const reset = event<{ slot: number }>({ from: "main", name: "reset" });
    reset.onReceive(({ slot }) => {
      z.write(slot);
    });
  });
  const onRecv = ctx.statements[0];
  if (onRecv?.kind !== "messageOnReceive") throw new Error("expected messageOnReceive");
  expect(onRecv.body).toHaveLength(1);
  expect(onRecv.body[0]).toMatchObject({
    kind: "stateStore",
    type: "f32",
    name: "counter",
  });
  // store value = Node<'f32'> produced via the field proxy = messageFieldRead AST
  const storeValue = (onRecv.body[0] as { value: { kind: string; name?: string; field?: string } })
    .value;
  expect(storeValue.kind).toBe("messageFieldRead");
  expect(storeValue.field).toBe("slot");
});

test("declaring a `message` without any onReceive calls is silently OK (unused declaration)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event<{ slot: number }>({ from: "main", name: "preset" });
  });
  expect(ctx.declarations).toHaveLength(1);
  expect(ctx.declarations[0]).toMatchObject({ kind: "message", name: "preset" });
});

test("`messageDecl.onReceive` accessing the same field multiple times pushes it to decl.fields only once", () => {
  // Even if the user accesses the same field multiple times (e.g. via
  // `({ slot, slot: alias })`), decl.fields seals it once (the proxy tracks
  // already-hit fields).
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const reset = event<{ slot: number }>({ from: "main", name: "reset" });
    reset.onReceive((payload) => {
      void (payload as Record<string, unknown>)["slot"];
      void (payload as Record<string, unknown>)["slot"];
    });
    const decl = ctx.declarations.find((d) => d.kind === "message");
    if (decl?.kind !== "message") throw new Error("expected message decl");
    // An inbound `number` field defaults to the f32 wire (its fraction survives);
    // it is not consumed by a bool sink here, so it stays f32.
    expect(decl.fields).toEqual([{ name: "slot", wireType: "f32" }]);
  });
});

test("`messageDecl.onReceive` typed-array field: `.at` / `.length` produce payload nodes and seal the field", () => {
  // `samples.length` → payloadFieldLength; `samples.at(idx)` → payloadFieldRead.
  // The field is sealed as a typed-array (payloadElementType = 'f32') per §4.3.
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const buf = state.buffer.f32({ size: 4 });
    const lenState = state.named("len").i32(0);
    const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
    upload.onReceive(({ samples }) => {
      lenState.write(samples.length);
      buf.write(0, samples.at(0));
    });
    const decl = ctx.declarations.find((d) => d.kind === "message");
    if (decl?.kind !== "message") throw new Error("expected message decl");
    expect(decl.fields).toEqual([{ name: "samples", wireType: "i32", payloadElementType: "f32" }]);
  });
  const onRecv = ctx.statements[0];
  if (onRecv?.kind !== "messageOnReceive") throw new Error("expected messageOnReceive");
  expect((onRecv.body[0] as { value: { kind: string } }).value.kind).toBe("payloadFieldLength");
  expect((onRecv.body[1] as { value: { kind: string } }).value.kind).toBe("payloadFieldRead");
});

test("inferAstType: messageFieldRead Node passed as an event emit field seals wireType as f32", () => {
  // Emitting an event inside a handler and re-passing an inbound `number` field
  // (a `Node<'f32'>` on the f32 wire) as a field value seals the outbound event
  // decl.fields entry as f32 — `number` rides the f32 wire end to end.
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const msg = event<{ slot: number }>({ from: "main", name: "preset" });
    const evt = event<{ value: number }>({ to: "main", name: "ack" });
    msg.onReceive(({ slot }) => {
      evt.emitIf(true, { atSample: 0, value: slot });
    });
    const evtDecl = ctx.declarations.find((d) => d.kind === "event");
    if (evtDecl?.kind !== "event") throw new Error("expected event decl");
    expect(evtDecl.fields).toEqual([{ name: "value", wireType: "f32" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// inferAstType: wire-type resolution when DSL primitive operators are passed
// as event field values (Q71). Arithmetic / math nodes resolve to f32;
// comparison nodes resolve to bool.
// ─────────────────────────────────────────────────────────────────────────

test("`emitIf` field value from an arithmetic node resolves wireType to f32 (inferAstType coverage)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const input = audioInput({ channels: 1, name: "main" });
    const evt = event<{ level: number }>({ to: "main", name: "peak" });
    forSample((i) => {
      evt.emitIf(true, { atSample: i, level: add(input.ch(0).at(i), 1) });
    });
    const evtDecl = ctx.declarations.find((d) => d.kind === "event");
    if (evtDecl?.kind !== "event") throw new Error("expected event decl");
    expect(evtDecl.fields).toEqual([{ name: "level", wireType: "f32" }]);
  });
});

test("`emitIf` field value from a comparison node resolves wireType to bool (inferAstType coverage)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const input = audioInput({ channels: 1, name: "main" });
    const evt = event<{ hot: boolean }>({ to: "main", name: "gate" });
    forSample((i) => {
      evt.emitIf(true, { atSample: i, hot: gt(input.ch(0).at(i), 0.5) });
    });
    const evtDecl = ctx.declarations.find((d) => d.kind === "event");
    if (evtDecl?.kind !== "event") throw new Error("expected event decl");
    expect(evtDecl.fields).toEqual([{ name: "hot", wireType: "bool" }]);
  });
});
