/**
 * Browser e2e (Part 4) — proves a `.uwk.ts` sugar processor runs end-to-end on
 * the real audio thread. `import "...uwk.ts?worklet"` drives the plugin's full
 * dev pipeline (transform-hook lowering → worklet entry → WASM compile →
 * `audioWorklet.addModule(...)`), and `createNode` + `startRendering` then run
 * the lowered processor in a real headless chromium AudioWorklet. A node-side
 * mock can pass while the browser fails, so this is the completion bar for the
 * `.uwk.ts` integration.
 *
 * Runs via `vp test --config vite.browser.config.ts` (excluded from the default
 * node-side `vp test`).
 */
import phasor from "./phasor.uwk.ts?worklet";
import { createNode } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

const SAMPLE_RATE = 48_000;
const RENDER_FRAMES = 128 * 4; // 4 quanta — enough to prove process() runs

test("a .uwk.ts processor lowers, compiles, and runs on the real audio thread", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: RENDER_FRAMES,
    sampleRate: SAMPLE_RATE,
  });

  // createNode → audioWorklet.addModule(...) → the lowered .uwk.ts worklet entry.
  const node = await createNode(ctx, phasor);
  expect(node.outputs.main).toBeTruthy();
  node.outputs.main!.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  // The lowered processor really ran: finite output AND it wrote actual signal
  // (a phasor is non-zero), not just a silent/zeroed buffer.
  expect(data.every((s) => Number.isFinite(s))).toBe(true);
  expect(data.some((s) => s !== 0)).toBe(true);

  node.dispose();
});
