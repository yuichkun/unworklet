import { expect, test, vi } from "vite-plus/test";
import { createNode } from "../../index.ts";
import lifetime from "./fixtures/lifetime.processor.ts?worklet";

test("dispose stops DSP execution after the queued shutdown is delivered", async () => {
  const NativeNode = AudioWorkletNode;
  let published: Int32Array | undefined;
  vi.stubGlobal(
    "AudioWorkletNode",
    class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        const buffer = options?.processorOptions?.publishBuffer as SharedArrayBuffer | undefined;
        if (buffer !== undefined) published = new Int32Array(buffer);
      }
    },
  );
  const ctx = new OfflineAudioContext(1, 128 * 32, 48000);
  try {
    const node = await createNode(ctx, lifetime);
    node.outputs.main!.connect(ctx.destination);
    const suspended = ctx.suspend((128 * 8) / 48000);
    const rendered = ctx.startRendering();
    await suspended;
    const count = published === undefined ? undefined : Atomics.load(published, 0);
    if (count !== undefined) expect(count).toBeGreaterThan(0);
    node.dispose();
    // Keep the native output connected so graph teardown cannot hide running DSP.
    node.node.connect(ctx.destination);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctx.resume();
    const output = (await rendered).getChannelData(0);
    expect(Array.from(output.subarray(0, 128 * 8)).every((sample) => sample > 0)).toBe(true);
    expect(Array.from(output.subarray(128 * 8))).toEqual(Array(128 * 24).fill(0));
    if (published !== undefined) expect(Atomics.load(published, 0)).toBe(count);
  } finally {
    vi.unstubAllGlobals();
  }
});
