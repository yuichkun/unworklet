/**
 * Declaration helper stub behavior (= `01-dsl.md` §1 / §3 / §4 +
 * `11-midi.md` §1). Phase 3 = every chain method throws `not implemented`
 * until the corresponding step fills the graph-register path.
 */

import { expect, test } from "vite-plus/test";

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
  ["param.f32", () => param.f32({ default: 0, min: 0, max: 1, automationRate: "k-rate" })],
  ["param.named", () => param.named("x")],
  ["param.expose", () => param.expose({ name: "x" })],
  ["audioInput", () => audioInput({ channels: 2, name: "main" })],
  ["audioOutput", () => audioOutput({ channels: 2, name: "main" })],
  ["event", () => event({ name: "evt" })],
  ["message", () => message({ name: "msg" })],
  ["midiInput", () => midiInput({ name: "mIn" })],
  ["midiOutput", () => midiOutput({ name: "mOut" })],
];

test.each(stubs)("`%s` stub throws not implemented", (_name, invoke) => {
  expect(invoke).toThrow(/not implemented/);
});
