/**
 * Browser e2e for the build-time path the demo can play: every example imported
 * through `?worklet`, the way most applications load a processor.
 *
 * Like the runtime-compile suite, it asserts the artifacts rather than a live
 * node, since `audioWorklet.addModule` needs an audio output device a headless
 * browser lacks. That the two paths produce the same WASM is checked in Node by
 * `compile-paths.test.ts`; what is checked here is that the browser receives a
 * loadable module, a valid WASM, and the 48 kHz rate the page plays it at.
 */
import { expect, test } from "vite-plus/test";

import { examples } from "./examples.ts";

test.each(examples.map((e) => [e.slug, e] as const))(
  "%s loads as the module the Vite plugin compiled",
  async (_slug, example) => {
    const { worklet } = await example.worklet();

    expect(worklet.processorName).toBeTruthy();
    expect(worklet.bakedSampleRate).toBe(48_000);
    const wasm = new Uint8Array(await (await fetch(worklet.wasmUrl!)).arrayBuffer());
    expect(Array.from(wasm.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
    const module = await (await fetch(worklet.moduleUrl!)).text();
    expect(module).toContain("registerProcessor");
  },
);
