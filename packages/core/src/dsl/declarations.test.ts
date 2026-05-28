/**
 * Declaration helper behavior (= `01-dsl.md` §1 / §3 / §4 + `11-midi.md`
 * §1). Step 3.2 = audioInput / audioOutput / param.f32 / param.named の
 * graph register、 Step 3.4 = `.ch(c).at(i)` reader / `.write(v)` writer /
 * `param.at(i)` の AST 還 元 を fill。 残 り (= state / buffer / event /
 * message / midi / param.expose) は throw stub 維 持。
 */

import { expect, test } from "vite-plus/test";

import { newCaptureContext, runCapture, unwrapAst, wrapAst } from "../compile/capture.ts";
import {
  audioInput,
  audioOutput,
  buffer,
  event,
  message,
  midiInput,
  midiOutput,
  param,
  state,
} from "./declarations.ts";
import { forSample } from "./loop.ts";

// ─────────────────────────────────────────────────────────────────────────
// stub 維 持 = state / buffer / param.expose / event / message / midi
// ─────────────────────────────────────────────────────────────────────────

const stubs: ReadonlyArray<readonly [string, () => unknown]> = [
  ["buffer.f32", () => buffer.f32({ size: 16 })],
  ["buffer.f64", () => buffer.f64({ size: 16 })],
  ["buffer.i32", () => buffer.i32({ size: 16 })],
  ["buffer.i64", () => buffer.i64({ size: 16 })],
  ["buffer.bool", () => buffer.bool({ size: 16 })],
  ["buffer.u8", () => buffer.u8({ size: 16 })],
  ["buffer.named", () => buffer.named("x")],
  ["buffer.expose", () => buffer.expose({ name: "x" })],
  ["param.expose", () => param.expose({ name: "x" })],
  ["event", () => event({ name: "evt" })],
  ["message", () => message({ name: "msg" })],
  ["midiInput", () => midiInput({ name: "mIn" })],
  ["midiOutput", () => midiOutput({ name: "mOut" })],
];

test.each(stubs)("`%s` stub throws not implemented", (_name, invoke) => {
  expect(invoke).toThrow(/not implemented/);
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

test("`audioInput` mono handle does NOT carry `.left` / `.right` sugar", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 1, name: "mono" });
    expect("left" in handle).toBe(false);
    expect("right" in handle).toBe(false);
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

test("`audioInput.left.at(i)` stereo sugar = `.ch(0).at(i)` 同 AST", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    const i = wrapAst<"i32">({ kind: "loopCounter" });
    expect(unwrapAst(handle.left.at(i))).toEqual(unwrapAst(handle.ch(0).at(i)));
  });
});

test("`audioInput.right.at(i)` stereo sugar = `.ch(1).at(i)` 同 AST", () => {
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

test("`audioOutput` mono handle does NOT carry `.left` / `.right` sugar", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 1, name: "mono" });
    expect("left" in handle).toBe(false);
    expect("right" in handle).toBe(false);
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

test("`audioOutput.left.at(i).write(v)` stereo sugar = channel 0 と 同 effect", () => {
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

test("`audioOutput.right.at(i).write(v)` stereo sugar = channel 1 と 同 effect", () => {
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

test("`.write(v)` inside `forSample` 内 = forSample body に append (= top statements に は 出 な い)", () => {
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
      body: [
        {
          kind: "audioOutWrite",
          portName: "mono",
          channel: 0,
          offset: { kind: "loopCounter" },
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

test("`param.f32(opts).named('X')` 後 付 け chain registers a `param` declaration", () => {
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

test("`param.named('X').f32(opts)` 前 付 け chain は 同 declaration shape を 生 む", () => {
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

test("chain で `.named` 重 複 = after-wins (= chain-rightmost name 採 用)", () => {
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

test("`param.at` の paramName は `.named` chain で update さ れ た name を 反 映 (= late binding)", () => {
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

test("`param` handle `.expose({...})` は throw stub 維 持", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = param
      .f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })
      .named("gain");
    expect(() => handle.expose({ name: "x" })).toThrow(/not implemented/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// state plain factory = Phase 7 sub-phase 7.1 (= state.<type>(initial)
// scalar slot を declare、 .load() / .store(v) で AST 還 元)
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

test("multiple plain `state` calls = synthetic name が unique (= __state_0 / __state_1 / ...)", () => {
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

test("`state.<type>(initial)` 5 type 全 declare (= f32 / f64 / i32 / i64 / bool)", () => {
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

test("`state.f32(0).load()` returns a `stateLoad` AST tied to decl.name", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    expect(unwrapAst(z.load())).toEqual({
      kind: "stateLoad",
      type: "f32",
      name: "__state_0",
    });
  });
});

test("`state.f32(0).store(Node)` appends a `stateStore` AST to statements", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    const v = wrapAst<"f32">({ kind: "literal", type: "f32", value: 0.5 });
    z.store(v);
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

test("`state.f32(0).store(literal)` lifts JS number to `f32` literal AST", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    z.store(0.25);
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

test("`state.i32(0).store(literal)` lifts JS number to `i32` literal AST", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.i32(0);
    z.store(42);
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

test("`state.bool(false).store(true)` lifts boolean to internal i32 (= 0/1) literal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const flag = state.bool(false);
    flag.store(true);
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

test("`state.bool(false).store(false)` lifts boolean to internal i32 0 literal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const flag = state.bool(true);
    flag.store(false);
  });
  expect(ctx.statements[0]).toEqual({
    kind: "stateStore",
    type: "bool",
    name: "__state_0",
    value: { kind: "literal", type: "i32", value: 0 },
  });
});

test("`state.i64(0n).store(bigint literal)` throws (= 後 続 sub-phase で fill)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.i64(0n);
    expect(() => z.store(42n)).toThrow(/i64 literal store not implemented/);
  });
});

test("`state.named('X').f32(0)` 前 付 け chain registers with name `X`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.named("meterL").f32(0);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "meterL", type: "f32", initial: 0, userNamed: true },
  ]);
});

test("`state.f32(0).named('X')` 後 付 け chain は decl.name を mutate (= 同 declare shape)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0).named("meterL");
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "meterL", type: "f32", initial: 0, userNamed: true },
  ]);
});

test("chain で `.named` 重 複 = after-wins (= chain-rightmost name 採 用)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.named("first").f32(0).named("final");
  });
  expect(ctx.declarations[0]?.name).toBe("final");
});

test("`state.<type>.load()` の name は `.named` 後 fix を 反 映 (= late binding)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = state.named("orig").f32(0).named("final");
    expect(unwrapAst(handle.load())).toEqual({
      kind: "stateLoad",
      type: "f32",
      name: "final",
    });
  });
});

test("`state.<type>.store(v)` の name も `.named` 後 fix を 反 映 (= late binding)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = state.f32(0).named("final");
    handle.store(0);
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "stateStore",
    name: "final",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// state.expose chain = sub-phase 7.2 (= `.named` / `.expose({...})` chain で
// name / snapshot / publish metadata を decl に 反 映、 graph-capture-time
// check で publish + 不 正 type / publish + name ナ シ / snapshot 'persistent' +
// name ナ シ / publish rateFps <= 0 を reject)
// ─────────────────────────────────────────────────────────────────────────

test("`state.expose({ name }).f32(0)` 前 付 け chain で declaration に name + userNamed true", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.expose({ name: "meterL" }).f32(0);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "meterL", type: "f32", initial: 0, userNamed: true },
  ]);
});

test("`state.f32(0).expose({ name })` 後 付 け chain で decl name + userNamed mutate", () => {
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

test("`state.expose({ name, snapshot, publish }).f32(0)` 全 field を 1 度 で 設 定", () => {
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

test("`state.f32(0).expose({...})` 後 付 け で snapshot + publish 反 映", () => {
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

test("chain 多 重 .expose で field merge (= after-wins)", () => {
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

test("chain で `.expose({ publish: { rateFps: 30 } })` 上 書 き 後 `.expose({ publish: { rateFps: 60 } })` = 60 wins", () => {
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

test("`state.expose({}).f32(0)` 空 options = plain factory と 等 価 (= synthetic name + userNamed false)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.expose({}).f32(0);
  });
  expect(ctx.declarations).toEqual([
    { kind: "state", name: "__state_0", type: "f32", initial: 0, userNamed: false },
  ]);
});

test("publish + 不 正 type (f64) は graph-capture-time error で reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ name: "x", publish: { rateFps: 30 } }).f64(0);
    }),
  ).toThrow(/publish is only supported on state\.f32 \/ state\.i32 \/ state\.bool/);
});

test("publish + 不 正 type (i64) は graph-capture-time error で reject", () => {
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

test("publish + name ナ シ = graph-capture-time error で reject", () => {
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

test("publish rateFps 負 値 = reject", () => {
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

test("snapshot 'persistent' + name ナ シ = graph-capture-time error で reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ snapshot: "persistent" }).f32(0);
    }),
  ).toThrow(/state slot with snapshot 'persistent' requires user-defined name/);
});

test("snapshot 'transient' + name ナ シ = OK (= plain と 等 価)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.expose({ snapshot: "transient" }).f32(0);
    }),
  ).not.toThrow();
});

test("handle.expose 後 付 け で publish 反 映 + validation 走 る", () => {
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

test("handle.expose 後 付 け で publish + synthetic name は reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const h = state.f32(0);
      h.expose({ publish: { rateFps: 30 } });
    }),
  ).toThrow(/state slot with publish requires user-defined name/);
});

test("handle.expose 後 付 け で name 上 書 き = decl mutate + 重 複 collide check", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const h = state.f32(0);
    h.expose({ name: "x" });
  });
  expect(ctx.declarations[0]).toMatchObject({ name: "x", userNamed: true });
});

test("handle.expose 後 付 け で 別 state と 同 name 移 動 で collide reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("first").f32(0);
      const h = state.f32(0);
      h.expose({ name: "first" });
    }),
  ).toThrow(/duplicate state declaration name "first"/);
});

test("`state.store(v)` inside `forSample` 内 = forSample body に append", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.f32(0);
    forSample(() => {
      z.store(0.5);
    });
  });
  expect(ctx.statements).toEqual([
    {
      kind: "forSample",
      stride: 1,
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
// state name uniqueness = 同 name の state declaration を 2 度 declare
// する path は graph-capture-time error で reject (= `01-dsl.md` §3.1 + Q5-b)
// ─────────────────────────────────────────────────────────────────────────

test("`state.named('x').f32(0)` を 2 度 declare で graph-capture-time error", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("dup").f32(0);
      state.named("dup").f32(0);
    }),
  ).toThrow(/duplicate state declaration name "dup"/);
});

test("`state.named('x').f32(0)` + `state.named('x').i32(0)` 型 違 い で も collide", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("dup").f32(0);
      state.named("dup").i32(0);
    }),
  ).toThrow(/duplicate state declaration name "dup"/);
});

test("`state.f32(0).named('x'); state.f32(0).named('x')` 後 付 け で も collide", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.f32(0).named("dup");
      state.f32(0).named("dup");
    }),
  ).toThrow(/duplicate state declaration name "dup"/);
});

test("plain factory 2 件 は synthetic name 自 動 unique で collide し な い (= regression check)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.f32(0);
      state.f32(0);
    }),
  ).not.toThrow();
  expect(ctx.declarations).toHaveLength(2);
});

test("`state.f32(0).named('orig').named('final')` 自 decl 上 書 き path は collide し な い", () => {
  // 同 decl を 2 度 .named() で 上 書 き する path は collide check で 自 decl
  // を 除 外 = 正 し く mutate 通 過 (= checkStateName の excludeDecl 引 数 path)。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    state.f32(0).named("orig").named("final");
  });
  expect(ctx.declarations[0]?.name).toBe("final");
});

test("既 declared 別 state の name に `.named()` で 移 動 で collide", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      state.named("first").f32(0);
      state.f32(0).named("first");
    }),
  ).toThrow(/duplicate state declaration name "first"/);
});
