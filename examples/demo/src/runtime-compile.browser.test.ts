/**
 * Browser e2e for the runtime-compile pipeline.
 *
 * Pins the contract that a `.uwk.ts` source STRING becomes a loadable,
 * bundler-free AudioWorklet module in the browser: lower + binaryen compile + a
 * self-contained Blob worklet module + a Blob WASM. This is exactly the path the
 * live editor runs, so the test guards it against regressions as unworklet
 * evolves.
 *
 * It asserts the COMPILED ARTIFACTS rather than spinning up a live node:
 * `audioWorklet.addModule` needs a real audio output device to resolve, which a
 * headless/CI browser lacks (the first call simply stalls). The live `createNode`
 * path is covered by `@unworklet/core`'s own handshake tests and by hands-on
 * verification in a real browser; what's unique here — and fully checkable
 * without an audio device — is that the browser emits a correct, self-contained
 * module + valid WASM with no bundler step.
 */
import { beforeAll, expect, test } from "vite-plus/test";

import { compileSource } from "@unworklet/lang/browser";

import { examples } from "./examples.ts";

// Warm up the module-level cost (binaryen.js, the TypeScript transpiler) once,
// outside the per-test timeout, so a test failure points at the compile output,
// not at first-compile latency.
beforeAll(async () => {
  await compileSource(`
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample((i) => { out.ch(0)[i] = f32(0); }); });`);
}, 20_000);

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

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"
const DEMO_DISTORTION = examples.find((example) => example.slug === "distortion")?.source;

async function fetchText(url: string): Promise<string> {
  return (await fetch(url)).text();
}
async function fetchBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

// The worklet module must be self-contained — Safari (and a Blob module on any
// engine) cannot resolve an `import` from inside addModule()'d code, so the
// runtime inlines the core runtime instead of importing it.
function expectSelfContainedModule(src: string): void {
  expect(src).toContain("registerProcessor");
  expect(src).toContain("__uwkMakeNs"); // the inlined core-runtime bundle
  expect(src).not.toMatch(/(^|\n)\s*import[\s{(]/); // no ESM import / dynamic import
}

test("compiles a .uwk.ts effect source to a loadable, self-contained worklet module + WASM", async () => {
  const proc = await compileSource(DISTORTION);
  expect(proc.worklet.moduleUrl).toBeTruthy();
  expect(proc.worklet.wasmUrl).toBeTruthy();
  expect(proc.worklet.processorName).toBeTruthy();

  expectSelfContainedModule(await fetchText(proc.worklet.moduleUrl!));
  expect(Array.from((await fetchBytes(proc.worklet.wasmUrl!)).slice(0, 4))).toEqual(WASM_MAGIC);
});

test("runtime compile emits a real WASM body for the demo distortion example", async () => {
  expect(DEMO_DISTORTION).toBeTruthy();

  const proc = await compileSource(DEMO_DISTORTION!);
  const wasm = await fetchBytes(proc.worklet.wasmUrl!);

  expect(Array.from(wasm.slice(0, 4))).toEqual(WASM_MAGIC);
  expect(wasm.byteLength).toBeGreaterThan(200);
});

test("compiles a MIDI synth source the same way — event.midi lowers + compiles in the browser", async () => {
  const proc = await compileSource(SYNTH);
  expect(proc.worklet.moduleUrl).toBeTruthy();
  expect(proc.worklet.wasmUrl).toBeTruthy();

  expectSelfContainedModule(await fetchText(proc.worklet.moduleUrl!));
  expect(Array.from((await fetchBytes(proc.worklet.wasmUrl!)).slice(0, 4))).toEqual(WASM_MAGIC);
});

test("each compile produces a distinct processor name (no addModule name collisions)", async () => {
  const a = await compileSource(DISTORTION);
  const b = await compileSource(DISTORTION);
  expect(a.worklet.processorName).not.toEqual(b.worklet.processorName);
});
