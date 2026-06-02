/**
 * Browser e2e for the runtime-compile pipeline.
 *
 * Pins the contract that a `.uwk.ts` source STRING can become a live
 * AudioWorklet node in the browser with no bundler step — lower + binaryen
 * compile + a Blob worklet module + addModule + createNode. This is the path the
 * live editor uses; keeping it here guards it against regressions as unworklet
 * evolves. No audio is connected to the destination, so the test is silent.
 */
import { createNode, replaceProcessor } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { compileSource } from "./runtimeCompile.ts";

const DISTORTION = `
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();
process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    const r = input.right[i] * drive[i];
    out.left[i]  = l > 1 ? 1 : l < -1 ? -1 : l;
    out.right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  });
});`;

const SYNTH = `
const out  = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });
const hz    = state.f32(440).named();
const gate  = state.f32(0).named();
const phase = state.f32(0).named();
process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    hz.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440);
    gate.write(1);
  });
  keys.onEvent("noteOff", () => gate.write(0));
  forSample((i) => {
    phase.write((phase + hz / 48000) % 1);
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * gate * 0.2;
  });
});`;

test("compiles a .uwk.ts effect source to a live node entirely in the browser", async () => {
  const proc = await compileSource(DISTORTION);
  expect(proc.worklet.moduleUrl).toBeTruthy();
  expect(proc.worklet.wasmUrl).toBeTruthy();
  expect(proc.worklet.processorName).toBeTruthy();

  const ctx = new AudioContext();
  await ctx.resume();
  const node = await createNode(ctx, proc);
  expect(Object.keys(node.outputs)).toContain("main");
  expect(Object.keys(node.inputs)).toContain("main");
  expect(node.params["drive"]).toBeDefined();
  node.dispose();
  await ctx.close();
});

test("replaceProcessor swaps to a freshly runtime-compiled source on a live node", async () => {
  const ctx = new AudioContext();
  await ctx.resume();
  const node = await createNode(ctx, await compileSource(DISTORTION));
  const r = await replaceProcessor(node, await compileSource(DISTORTION));
  expect(r.node).toBeDefined();
  expect(Object.keys(r.node.outputs)).toContain("main");
  r.node.dispose();
  await ctx.close();
});

test("compiles a MIDI synth source — the midi port is wired on the live node", async () => {
  const proc = await compileSource(SYNTH);
  const ctx = new AudioContext();
  await ctx.resume();
  const node = await createNode(ctx, proc);
  expect(Object.keys(node.outputs)).toContain("main");
  expect(node.midi["keys"]).toBeDefined();
  node.dispose();
  await ctx.close();
});
