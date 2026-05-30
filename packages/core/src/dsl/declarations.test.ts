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
import { add, gt } from "./primitives.ts";

// ─────────────────────────────────────────────────────────────────────────
// stub 維 持 = param.expose / midi (= buffer / message は 別 path で 実 装 済 み)
// ─────────────────────────────────────────────────────────────────────────

const stubs: ReadonlyArray<readonly [string, () => unknown]> = [
  ["param.expose", () => param.expose({ name: "x" })],
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

test("`state.i64(0n).store(bigint literal)` captures an `i64` literal AST", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.i64(0n);
    z.store(42n);
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
// buffer declaration = `buffer.<type>({ size })` + .named / .expose chain
// (= `01-dsl.md` §3.2)。 read / write / readInterpolated の 振 る 舞 い は 黒 箱
// (`../__tests__/behavior/buffer.test.ts`)、 ここ は 宣 言 / chain / validate。
// ─────────────────────────────────────────────────────────────────────────

test("`buffer.f32({ size })` registers a `buffer` declaration with synthetic name", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    buffer.f32({ size: 64 });
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

test("`buffer.<type>({ size })` 6 element 型 全 declare (= f32 / f64 / i32 / i64 / bool / u8)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    buffer.f32({ size: 1 });
    buffer.f64({ size: 2 });
    buffer.i32({ size: 3 });
    buffer.i64({ size: 4 });
    buffer.bool({ size: 5 });
    buffer.u8({ size: 6 });
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

test("`buffer.named('X').f32({ size })` 前 付 け chain は name を 反 映", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    buffer.named("ring").f32({ size: 16 });
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

test("`buffer.f32({ size }).named('X')` 後 付 け chain も 同 declaration", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    buffer.f32({ size: 16 }).named("ring");
  });
  expect(ctx.declarations.map((d) => (d.kind === "buffer" ? d.name : "?"))).toEqual(["ring"]);
});

test("buffer name uniqueness = 同 name を 2 度 declare で graph-capture-time error", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      buffer.named("dup").f32({ size: 4 });
      buffer.named("dup").i32({ size: 4 });
    }),
  ).toThrow(/duplicate buffer declaration name "dup"/);
});

test("buffer publish は 全 element 型 で 許 容 (= state の Q42 制 限 ナ シ)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      buffer.f64({ size: 8 }).expose({ name: "spectrum", publish: { rateFps: 30 } });
    }),
  ).not.toThrow();
});

test("buffer publish + name ナ シ = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      buffer.f32({ size: 8 }).expose({ publish: { rateFps: 30 } });
    }),
  ).toThrow(/buffer with publish requires user-defined name/);
});

test("buffer publish rateFps <= 0 = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      buffer.f32({ size: 8 }).expose({ name: "x", publish: { rateFps: 0 } });
    }),
  ).toThrow(/publish rateFps must be a positive finite number/);
});

test("buffer snapshot 'persistent' + name ナ シ = reject", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      buffer.f32({ size: 8 }).expose({ snapshot: "persistent" });
    }),
  ).toThrow(/buffer with snapshot 'persistent' requires user-defined name/);
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

// ─────────────────────────────────────────────────────────────────────────
// `event<T>` factory + handle (= `01-dsl.md` §4.1)
// ─────────────────────────────────────────────────────────────────────────

test("`event` outside `defineProcessor` body throws", () => {
  expect(() => event({ name: "evt" })).toThrow(/outside `defineProcessor` body/);
});

test("`event({ name })` registers an `event` declaration with default capacity 256", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ name: "peak" });
  });
  expect(ctx.declarations).toEqual([
    { kind: "event", name: "peak", capacity: 256, payloadCapacity: undefined, fields: [] },
  ]);
});

test("`event({ name, capacity })` accepts capacity override", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ name: "peak", capacity: 32 });
  });
  expect(ctx.declarations).toEqual([
    { kind: "event", name: "peak", capacity: 32, payloadCapacity: undefined, fields: [] },
  ]);
});

test("`event({ name, payloadCapacity })` accepts payloadCapacity option", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event({ name: "spectrum", payloadCapacity: 4096 });
  });
  expect(ctx.declarations).toEqual([
    { kind: "event", name: "spectrum", capacity: 256, payloadCapacity: 4096, fields: [] },
  ]);
});

test("`event` returns a handle carrying `name`", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = event({ name: "peak" });
    expect(handle.name).toBe("peak");
  });
});

test("重 複 `event` name = graph-capture-time error", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      event({ name: "shared" });
      event({ name: "shared" });
    }),
  ).toThrow(/duplicate event declaration name "shared"/);
});

test("`event` を declare し て emit ナ シ で も silent OK (= unused declaration)", () => {
  // `01-dsl.md` §3.4 + canonical Ex 5 grainSpawned (emit ナ シ path) 規 範。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    event<{ voice: number; pos: number }>({ name: "grainSpawned" });
  });
  expect(ctx.declarations).toHaveLength(1);
  expect(ctx.declarations[0]).toMatchObject({ kind: "event", name: "grainSpawned", fields: [] });
});

// ─────────────────────────────────────────────────────────────────────────
// `eventDecl.emitIf` graph capture + Q71 per-field wire-type resolution
// ─────────────────────────────────────────────────────────────────────────

test("`emitIf(true, payload)` per-block top-level で eventEmitIf statement を append", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
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

test("`emitIf(false, payload)` も AST に capture (= fold は 後 続 analyze で)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    evt.emitIf(false, { atSample: 0, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    cond: { kind: "literal", type: "i32", value: 0 },
  });
});

test("`emitIf` `forSample` 内 = loop body に append (= top statements に は 出 な い)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    forSample(() => {
      evt.emitIf(true, { atSample: 0, level: 0.25 });
    });
  });
  // top statements = forSample 1 件 だ け
  expect(ctx.statements).toHaveLength(1);
  expect(ctx.statements[0]?.kind).toBe("forSample");
  // forSample body に eventEmitIf が 含 ま れ る
  const fs = ctx.statements[0];
  if (fs?.kind !== "forSample") throw new Error("expected forSample");
  expect(fs.body).toHaveLength(1);
  expect(fs.body[0]?.kind).toBe("eventEmitIf");
});

// ─────────────────────────────────────────────────────────────────────────
// atSample default lift (= forSample 内 = i / per-block top = 0) + override
// ─────────────────────────────────────────────────────────────────────────

test("atSample 省 略 = `forSample` 内 で loopCounter (= i) を default lift", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
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

test("atSample 省 略 = per-block top で literal 0 を default lift", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    evt.emitIf(true, { level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "literal", type: "i32", value: 0 },
  });
});

test("atSample 明 示 = `forSample` 内 で も user override 通 過 (= number literal)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
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

test("atSample 明 示 = `forSample` 内 で Node<'i32'> override 通 過", () => {
  // user が i 以 外 の sample-offset 計 算 を 明 示 で 渡 す path = override 維 持。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    forSample(() => {
      // loopCounter を 明 示 で 渡 す = override path (= default と 結 果 同 値 だ が
      // 経 路 が 違 う = user 明 示 path も regression を 拾 う)
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

test("atSample 明 示 = per-block top で user override 通 過 (= 任 意 i32 literal)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    evt.emitIf(true, { atSample: 64, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "literal", type: "i32", value: 64 },
  });
});

test("atSample 不 正 型 (= string) = throw (= override path で 不 正 値 reject)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number }>({ name: "peak" });
      // @ts-expect-error — atSample に string = 不 正 型
      evt.emitIf(true, { atSample: "0", level: 0.5 });
    }),
  ).toThrow(/atSample" must be Node<'i32'> or number/);
});

test("Q71: 1 番 目 emit site で field wire 型 を seal (= number → f32 default)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    evt.emitIf(true, { atSample: 0, level: 0.5 });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "level", wireType: "f32" }]);
  });
});

test("Q71: 同 wire 型 で 後 続 emit site = 受 容", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    evt.emitIf(true, { atSample: 0, level: 0.5 });
    evt.emitIf(true, { atSample: 0, level: 0.25 });
  });
  expect(ctx.statements).toHaveLength(2);
});

test("Q71: wire 型 不 一 致 = graph-capture-time error (= event-field-type-mismatch)", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number }>({ name: "peak" });
      evt.emitIf(true, { atSample: 0, level: 0.5 });
      // 2 番 目 emit site で boolean field 値 → wireType = bool で seal 不 一 致
      evt.emitIf(true, { atSample: 0, level: true as unknown as number });
    }),
  ).toThrow(/event "peak" field "level" wire-type mismatch/);
});

test("Q71: field set 縮 小 = graph-capture-time error (= missing field)", () => {
  // 1 番 目 emit で level + channel seal、 2 番 目 emit で channel 省 略 = TS は
  // EmitPayload<T> で field missing を error と 出 す path だ が runtime check
  // が 規 範 = `as` cast で TS を 通 し て runtime path だ け 試 す。
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number; channel: number }>({ name: "peak" });
      evt.emitIf(true, { atSample: 0, level: 0.5, channel: 0 });
      (evt as unknown as { emitIf: (c: boolean, p: Record<string, unknown>) => void }).emitIf(
        true,
        { atSample: 0, level: 0.25 },
      );
    }),
  ).toThrow(/missing field\(s\) "channel"/);
});

test("Q71: 新 field を 後 続 emit site で 導 入 = error", () => {
  // 1 番 目 emit が level だ け seal、 2 番 目 emit で channel を 新 規 持 ち 込 み。
  // TS は EmitPayload<T> で channel も T 由 来 = 受 容 す る path = `@ts-expect-error`
  // 不 要 = runtime check で reject。
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number; channel: number }>({ name: "peak" });
      (evt as unknown as { emitIf: (c: boolean, p: Record<string, unknown>) => void }).emitIf(
        true,
        { atSample: 0, level: 0.5 },
      );
      evt.emitIf(true, { atSample: 0, level: 0.25, channel: 0 });
    }),
  ).toThrow(/introduces new field "channel"/);
});

test("`emitIf` Node<'bool'> cond = unwrapAst で AST 化", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    const condNode = wrapAst<"bool">({ kind: "literal", type: "i32", value: 1 });
    evt.emitIf(condNode, { atSample: 0, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    cond: { kind: "literal", type: "i32", value: 1 },
  });
});

test("`emitIf` Node<'i32'> atSample = unwrapAst で AST 化", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ level: number }>({ name: "peak" });
    const atSampleNode = wrapAst<"i32">({ kind: "loopCounter" });
    evt.emitIf(true, { atSample: atSampleNode, level: 0.5 });
  });
  expect(ctx.statements[0]).toMatchObject({
    kind: "eventEmitIf",
    atSample: { kind: "loopCounter" },
  });
});

test("`emitIf` field 値 が 不 正 型 = throw", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ level: number }>({ name: "peak" });
      // @ts-expect-error — 不 正 field 型 (= string)
      evt.emitIf(true, { atSample: 0, level: "hi" });
    }),
  ).toThrow(/value must be Node<T>, number, or boolean/);
});

test("Q71: Node<'i32'> field 値 = wireType i32 で seal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ tick: number }>({ name: "ticker" });
    const tickNode = wrapAst<"i32">({ kind: "loopCounter" });
    evt.emitIf(true, { atSample: 0, tick: tickNode });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "tick", wireType: "i32" }]);
  });
});

test("Q71: bool field 値 = wireType bool で seal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ flag: boolean }>({ name: "flagger" });
    evt.emitIf(true, { atSample: 0, flag: true });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "flag", wireType: "bool" }]);
  });
});

test("Q71: number literal は seal 済 wire 型 (= i32) に lift", () => {
  // 1 番 目 emit で Node<'i32'> で i32 を seal、 2 番 目 emit の number literal は
  // seal 済 wire 型 (= i32) に lift し て AST 化 さ れ る (= default f32 lift と
  // 異 な る path)。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ tick: number }>({ name: "ticker" });
    const tickNode = wrapAst<"i32">({ kind: "loopCounter" });
    evt.emitIf(true, { atSample: 0, tick: tickNode });
    evt.emitIf(true, { atSample: 0, tick: 42 });
  });
  expect(ctx.statements[1]).toMatchObject({
    fields: [{ name: "tick", wireType: "i32", value: { kind: "literal", type: "i32", value: 42 } }],
  });
});

test("inferAstType: literal Node field 値 = literal.type 由 来 で seal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ value: number }>({ name: "lit" });
    const litF64 = wrapAst<"f64">({ kind: "literal", type: "f64", value: 1.5 });
    evt.emitIf(true, { atSample: 0, value: litF64 });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f64" }]);
  });
});

test("inferAstType: mul Node field 値 = mul.type 由 来 で seal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const evt = event<{ value: number }>({ name: "muller" });
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

test("inferAstType: audioInRead Node field 値 = f32 で seal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const input = audioInput({ channels: 1, name: "main" });
    const evt = event<{ value: number }>({ name: "echo" });
    evt.emitIf(true, { atSample: 0, value: input.ch(0).at(0) });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f32" }]);
  });
});

test("inferAstType: paramAt Node field 値 = f32 で seal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const gain = param.named("gain").f32({
      default: 0.5,
      min: 0,
      max: 1,
      automationRate: "a-rate",
    });
    const evt = event<{ value: number }>({ name: "echo" });
    evt.emitIf(true, { atSample: 0, value: gain.at(0) });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f32" }]);
  });
});

test("inferAstType: stateLoad Node field 値 = state.type 由 来 で seal", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.named("z").f64(0);
    const evt = event<{ value: number }>({ name: "echo" });
    evt.emitIf(true, { atSample: 0, value: z.load() });
    const decl = ctx.declarations.find((d) => d.kind === "event");
    if (decl?.kind !== "event") throw new Error("expected event decl");
    expect(decl.fields).toEqual([{ name: "value", wireType: "f64" }]);
  });
});

test("inferAstType: statement kind が AST で 来 る = throw (= defensive guard)", () => {
  // 構 造 上 user code か ら は 到 達 し な い path (= statement AstNode は wrapAst
  // で 包 ま な い)、 defensive guard を 直 接 hit さ せ る た め stateStore kind を
  // 強 制 wrap し て field 値 で 渡 す。
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      const evt = event<{ value: number }>({ name: "echo" });
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
// state.expose 後 付 け 同 name 再 set = userNamed promote (= sub-phase 7.2 残 path)
// ─────────────────────────────────────────────────────────────────────────

test("`state.expose({ name })` 同 name 再 set = userNamed promote", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    // synthetic name (= __state_0) で declare 後、 .expose で 同 name (= __state_0)
    // 再 set = userNamed flag を true へ promote (= snapshot 'persistent' 等 で
    // userNamed 必 須 path を 通 す)。
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
  expect(() => message({ name: "msg" })).toThrow(/outside `defineProcessor` body/);
});

test("`message({ name })` registers a `message` declaration with default capacity 256", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    message({ name: "reset" });
  });
  expect(ctx.declarations).toEqual([
    { kind: "message", name: "reset", capacity: 256, payloadCapacity: undefined, fields: [] },
  ]);
});

test("`message({ name, capacity })` accepts capacity override", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    message({ name: "preset", capacity: 16 });
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
    const handle = message({ name: "preset" });
    expect(handle.name).toBe("preset");
  });
});

test("重 複 `message` name = graph-capture-time error", () => {
  const ctx = newCaptureContext();
  expect(() =>
    runCapture(ctx, () => {
      message({ name: "shared" });
      message({ name: "shared" });
    }),
  ).toThrow(/duplicate message declaration name "shared"/);
});

test("`messageDecl.onReceive(handler)` で 統 計 ナ シ handler を build-time eval し て AST `messageOnReceive` を statements に push", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const reset = message<{ slot: number }>({ name: "reset" });
    reset.onReceive(() => {
      // body 内 で AST 構 築 ナ シ = 空 handler
    });
  });
  expect(ctx.statements).toHaveLength(1);
  expect(ctx.statements[0]).toMatchObject({
    kind: "messageOnReceive",
    name: "reset",
    body: [],
  });
});

test("`messageDecl.onReceive` 複 数 registration = source order で statements に 並 ぶ (= Q38-c)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const reset = message<{ slot: number }>({ name: "reset" });
    reset.onReceive(() => {});
    reset.onReceive(() => {});
  });
  expect(ctx.statements).toHaveLength(2);
  expect(ctx.statements[0]?.kind).toBe("messageOnReceive");
  expect(ctx.statements[1]?.kind).toBe("messageOnReceive");
});

test("`messageDecl.onReceive` handler 引 数 = Q46 lift proxy で field access = Node<'i32'>", () => {
  // handler が `({ slot }) => ...` で destructure す る = framework が proxy hand
  // し て field "slot" access を Node<'i32'> proxy で 返 す path (= Q46 uniform lift)。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const z = state.named("counter").i32(0);
    const reset = message<{ slot: number }>({ name: "reset" });
    reset.onReceive(({ slot }) => {
      z.store(slot);
    });
  });
  const onRecv = ctx.statements[0];
  if (onRecv?.kind !== "messageOnReceive") throw new Error("expected messageOnReceive");
  expect(onRecv.body).toHaveLength(1);
  expect(onRecv.body[0]).toMatchObject({
    kind: "stateStore",
    type: "i32",
    name: "counter",
  });
  // store value = field proxy 経 由 で AST 化 さ れ た Node<'i32'> = messageFieldRead AST
  const storeValue = (onRecv.body[0] as { value: { kind: string; name?: string; field?: string } })
    .value;
  expect(storeValue.kind).toBe("messageFieldRead");
  expect(storeValue.field).toBe("slot");
});

test("`message` を declare し て onReceive ナ シ で も silent OK (= unused declaration)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    message<{ slot: number }>({ name: "preset" });
  });
  expect(ctx.declarations).toHaveLength(1);
  expect(ctx.declarations[0]).toMatchObject({ kind: "message", name: "preset" });
});

test("`messageDecl.onReceive` 同 field を 複 数 回 access し て も decl.fields に 1 回 だ け push", () => {
  // user が destructure 経 由 で `({ slot, slot: alias })` の よ う に 同 field を
  // 複 数 回 access し て も、 decl.fields は 1 件 で seal (= proxy が 既 hit を check)。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const reset = message<{ slot: number }>({ name: "reset" });
    reset.onReceive((payload) => {
      void (payload as Record<string, unknown>)["slot"];
      void (payload as Record<string, unknown>)["slot"];
    });
    const decl = ctx.declarations.find((d) => d.kind === "message");
    if (decl?.kind !== "message") throw new Error("expected message decl");
    expect(decl.fields).toEqual([{ name: "slot", wireType: "i32" }]);
  });
});

test("`messageDecl.onReceive` typed-array field = `.at` / `.length` で payload node 化 + field seal", () => {
  // `samples.length` → payloadFieldLength、 `samples.at(idx)` → payloadFieldRead。
  // field は typed-array seal (= payloadElementType = 'f32') さ れ る (= §4.3)。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const buf = buffer.f32({ size: 4 });
    const lenState = state.named("len").i32(0);
    const upload = message<{ samples: Float32Array }>({ name: "upload" });
    upload.onReceive(({ samples }) => {
      lenState.store(samples.length);
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

test("inferAstType: messageFieldRead Node を event emit field に 渡 す = wireType i32 で seal", () => {
  // handler 内 で event emit を 走 ら し て、 payload field 値 に messageFieldRead
  // Node<'i32'> を 渡 す path = event decl.fields に i32 で seal さ れ る。
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const msg = message<{ slot: number }>({ name: "preset" });
    const evt = event<{ value: number }>({ name: "ack" });
    msg.onReceive(({ slot }) => {
      evt.emitIf(true, { atSample: 0, value: slot });
    });
    const evtDecl = ctx.declarations.find((d) => d.kind === "event");
    if (evtDecl?.kind !== "event") throw new Error("expected event decl");
    expect(evtDecl.fields).toEqual([{ name: "value", wireType: "i32" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// inferAstType: DSL primitive operator を event field 値 に 流 し た 時 の
// wire-type resolution (= Q71)。 算 術 / math は 結 果 型 (f32)、 比 較 は bool。
// ─────────────────────────────────────────────────────────────────────────

test("`emitIf` field 値 が 算 術 node → wireType f32 (= inferAstType 網 羅)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const input = audioInput({ channels: 1, name: "main" });
    const evt = event<{ level: number }>({ name: "peak" });
    forSample((i) => {
      evt.emitIf(true, { atSample: i, level: add(input.ch(0).at(i), 1) });
    });
    const evtDecl = ctx.declarations.find((d) => d.kind === "event");
    if (evtDecl?.kind !== "event") throw new Error("expected event decl");
    expect(evtDecl.fields).toEqual([{ name: "level", wireType: "f32" }]);
  });
});

test("`emitIf` field 値 が 比 較 node → wireType bool (= inferAstType 網 羅)", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const input = audioInput({ channels: 1, name: "main" });
    const evt = event<{ hot: boolean }>({ name: "gate" });
    forSample((i) => {
      evt.emitIf(true, { atSample: i, hot: gt(input.ch(0).at(i), 0.5) });
    });
    const evtDecl = ctx.declarations.find((d) => d.kind === "event");
    if (evtDecl?.kind !== "event") throw new Error("expected event decl");
    expect(evtDecl.fields).toEqual([{ name: "hot", wireType: "bool" }]);
  });
});
