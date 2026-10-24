import { expect, test } from "vite-plus/test";
import { createNode } from "../../index.ts";
import type { CompiledProcessor } from "../../types.ts";
import portless from "./fixtures/portless.processor.ts?worklet";
import eventEmitter from "./fixtures/event-emitter.processor.ts?worklet";

for (const kind of ["midi", "event"] as const) {
  for (const stopped of ["closed", "suspended"] as const) {
    test(`${kind} retained during contention is delivered while ${stopped}`, async () => {
      const NativeNode = globalThis.AudioWorkletNode;
      let access: Int32Array | undefined;
      globalThis.AudioWorkletNode = class extends NativeNode {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options);
          access = new Int32Array(options!.processorOptions.egressAccessBuffer);
        }
      };
      const ctx = new OfflineAudioContext(1, stopped === "closed" ? 128 : 256, 48000);
      let node: Awaited<ReturnType<typeof createNode>>;
      try {
        node = await createNode(
          ctx,
          (kind === "midi" ? portless : eventEmitter) as CompiledProcessor<unknown>,
        );
      } finally {
        globalThis.AudioWorkletNode = NativeNode;
      }
      const received: unknown[] = [];
      let rendering: Promise<AudioBuffer> | undefined;
      try {
        node.node.connect(ctx.destination);
        if (kind === "midi") {
          node.midi.output!.onEvent("noteOn", (event) => received.push(event));
          node.midi.input!.send({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
        } else {
          node.events.peak!.on((event) => received.push(event));
        }
        await node.snapshot();
        access!.fill(1);
        const suspended = stopped === "suspended" ? ctx.suspend(127 / 48000) : undefined;
        rendering = ctx.startRendering();
        await (suspended ?? rendering);
        expect(ctx.state).toBe(stopped);
        // Even an explicit flush must not steal the receiver's ownership.
        node.node.port.postMessage({ kind: "egress-flush" });
        await node.snapshot();
        expect(received).toEqual([]);
        access!.fill(0);
        const expected =
          kind === "midi"
            ? [{ type: "noteOn", channel: 0, note: 60, velocity: 100 }]
            : Array.from({ length: 16 }, (_, i) => ({ atSample: 112 + i, level: 0 }));
        await expect.poll(() => received).toEqual(expected);
        // Repeated publications do not advance DSP or redeliver consumed slots.
        const before = await node.snapshot();
        node.node.port.postMessage({ kind: "egress-flush" });
        expect(await node.snapshot()).toEqual(before);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        expect(received).toEqual(expected);
        expect(ctx.state).toBe(stopped);
      } finally {
        access!.fill(0);
        node.dispose();
        if (ctx.state === "suspended") await ctx.resume();
        await rendering;
      }
    });
  }
}
