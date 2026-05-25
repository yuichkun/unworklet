/**
 * Declaration helper behavior (= `01-dsl.md` §1 / §3 / §4 + `11-midi.md`
 * §1). Step 3.2 = audioInput / audioOutput / param.f32 / param.named の
 * graph register が fill、 残 り (= state / buffer / event / message /
 * midi / param.expose) は throw stub 維 持。
 */

import { expect, test } from "vite-plus/test";

import { newCaptureContext, runCapture } from "../compile/capture.ts";
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
// audioInput = Step 3.2 fill
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

test("`audioInput` handle `.ch(c)` is Step 3.4 待 ち = throws", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    expect(() => handle.ch(0)).toThrow(/not implemented/);
  });
});

test("`audioInput` stereo handle `.left` access is Step 3.4 待 ち = throws", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    expect(() => handle.left).toThrow(/not implemented/);
  });
});

test("`audioInput` stereo handle `.right` access is Step 3.4 待 ち = throws", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioInput({ channels: 2, name: "main" });
    expect(() => handle.right).toThrow(/not implemented/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// audioOutput = Step 3.2 fill
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

test("`audioOutput` handle `.ch(c)` is Step 3.4 待 ち = throws", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    expect(() => handle.ch(0)).toThrow(/not implemented/);
  });
});

test("`audioOutput` stereo handle `.left` access is Step 3.4 待 ち = throws", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    expect(() => handle.left).toThrow(/not implemented/);
  });
});

test("`audioOutput` stereo handle `.right` access is Step 3.4 待 ち = throws", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = audioOutput({ channels: 2, name: "main" });
    expect(() => handle.right).toThrow(/not implemented/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// param chain = Step 3.2 fill (= `.f32(opts).named('X')` + 順 序 free)
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

test("`param` handle `.at(i)` is Step 3.4 待 ち = throws", () => {
  const ctx = newCaptureContext();
  runCapture(ctx, () => {
    const handle = param
      .f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })
      .named("gain");
    expect(() => handle.at(0)).toThrow(/not implemented/);
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
