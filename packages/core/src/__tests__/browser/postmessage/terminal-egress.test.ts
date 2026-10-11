import { expect, test } from "vite-plus/test";
import { createNode } from "../../../index.ts";
import frameCapture from "../fixtures/frame-capture.processor.ts?worklet";
for (const stopped of ["closed", "suspended"] as const) {
  for (const seedBefore of [false, true]) {
    test(`retained frame events publish when pool buffers arrive, before render=${seedBefore}, ${stopped}`, async () => {
      const Native = globalThis.AudioWorkletNode;
      const held: Array<() => void> = [];
      globalThis.AudioWorkletNode = class extends Native {
        constructor(ctx: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(ctx, name, options);
          const post = this.port.postMessage.bind(this.port);
          this.port.postMessage = ((data: { kind?: string }, transfer: Transferable[]) => {
            if (data.kind === "egress-buffer") held.push(() => post(data, transfer));
            else post(data, transfer);
          }) as typeof this.port.postMessage;
        }
      };
      const ctx = new OfflineAudioContext(1, stopped === "closed" ? 384 : 512, 48000);
      let node: Awaited<ReturnType<typeof createNode>>;
      try {
        node = await createNode(ctx, frameCapture);
      } finally {
        globalThis.AudioWorkletNode = Native;
      }
      const got: unknown[] = [];
      let rendering: Promise<AudioBuffer> | undefined;
      try {
        node.outputs.main!.connect(ctx.destination);
        const buffer = ctx.createBuffer(1, 512, 48000);
        buffer.getChannelData(0).fill(0.25);
        const source = new AudioBufferSourceNode(ctx, { buffer });
        source.connect(node.inputs.main!);
        source.start();
        node.events.frame!.on((x) => got.push(x));
        if (seedBefore) {
          held.forEach((f) => f());
          await node.snapshot();
        }
        const suspended = stopped === "suspended" ? ctx.suspend(383 / 48000) : undefined;
        rendering = ctx.startRendering();
        await (suspended ?? rendering);
        const before = await node.snapshot();
        if (!seedBefore) held.forEach((f) => f());
        await node.snapshot();
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        expect(ctx.state).toBe(stopped);
        expect(got.length).toBe(3);
        expect(got).toEqual(
          Array.from({ length: 3 }, () => ({
            atSample: 0,
            samples: new Float32Array(8).fill(0.25),
          })),
        );
        expect(await node.snapshot()).toEqual(before);
        expect(got.length).toBe(3);
      } finally {
        node.dispose();
        if (ctx.state === "suspended") await ctx.resume();
        await rendering;
      }
    });
  }
}
