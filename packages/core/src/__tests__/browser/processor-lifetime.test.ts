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
    const count = Atomics.load(published!, 0);
    expect(count).toBeGreaterThan(0);
    node.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctx.resume();
    await rendered;
    expect(Atomics.load(published!, 0)).toBe(count);
  } finally {
    vi.unstubAllGlobals();
  }
});
