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
  ["state.f32", () => state.f32(0)],
  ["state.f64", () => state.f64(0)],
  ["state.i32", () => state.i32(0)],
  ["state.i64", () => state.i64(0n)],
  ["state.bool", () => state.bool(false)],
  ["state.named", () => state.named("x")],
  ["state.expose", () => state.expose({ name: "x" })],
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
