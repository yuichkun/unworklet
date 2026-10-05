import { expect, test } from "vite-plus/test";
import { createNode, inspectSnapshot, replaceProcessor } from "../../index.ts";
import frozenCounter from "./fixtures/restore-frozen-counter.processor.ts?worklet";
import oldProcessor from "./fixtures/snapshot-old.processor.ts?worklet";
import nextProcessor from "./fixtures/snapshot-next.processor.ts?worklet";

test("snapshot preserves initial and suspended AudioParam settings before rendering", async () => {
  const ctx = new OfflineAudioContext(1, 128, 48000);
  const node = await createNode(ctx, oldProcessor, { initial: { gain: 0.6 } });
  try {
    expect(inspectSnapshot(await node.snapshot()).slots.gain).toEqual({
      kind: "param",
      value: Math.fround(0.6),
    });
    node.params.gain!.value = 0.4;
    expect(inspectSnapshot(await node.snapshot()).slots.gain).toEqual({
      kind: "param",
      value: Math.fround(0.4),
    });
  } finally {
    node.dispose();
  }
});

test("restore skips a state whose type changed without reinterpreting its bytes", async () => {
  const ctx = new OfflineAudioContext(1, 128, 48000);
  const oldNode = await createNode(ctx, oldProcessor);
  const nextNode = await createNode(ctx, nextProcessor);
  try {
    const result = await nextNode.restore(await oldNode.snapshot());
    expect(result.skipped).toContain("value");
    expect(result.applied).not.toContain("value");
    expect(inspectSnapshot(await nextNode.snapshot()).slots.value).toEqual({
      kind: "state",
      type: "i32",
      value: 7,
    });
    nextNode.outputs.main!.connect(ctx.destination);
    expect(Array.from((await ctx.startRendering()).getChannelData(0))).toEqual(Array(128).fill(7));
  } finally {
    oldNode.dispose();
    nextNode.dispose();
  }
});

test("suspended snapshots round-trip through restore and replacement before rendering", async () => {
  const ctx = new OfflineAudioContext(1, 512, 48000);
  const node = await createNode(ctx, oldProcessor, { initial: { gain: 0.6 } });
  const target = await createNode(ctx, oldProcessor);
  try {
    const blob = await node.snapshot();
    expect((await target.restore(blob)).ok).toBe(true);
    expect(target.params.gain!.value).toBe(Math.fround(0.6));
    const replacement = await replaceProcessor(node, oldProcessor);
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error("replacement failed");
    try {
      expect(replacement.node.params.gain!.value).toBe(Math.fround(0.6));
      replacement.node.outputs.main!.connect(ctx.destination);
      const suspended = ctx.suspend(128 / 48000);
      const rendering = ctx.startRendering();
      await suspended;
      replacement.node.params.gain!.value = 0.4;
      expect(inspectSnapshot(await replacement.node.snapshot()).slots.gain).toEqual({
        kind: "param",
        value: Math.fround(0.4),
      });
      await ctx.resume();
      await rendering;
    } finally {
      replacement.node.dispose();
    }
  } finally {
    node.dispose();
    target.dispose();
  }
});

test("live restore keeps a frozen accumulator unchanged while the main thread is busy", async () => {
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.suspend();
  const node = await createNode(ctx, frozenCounter);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.outputs.main!.connect(mute);
  mute.connect(ctx.destination);
  try {
    const saved = await node.snapshot();
    node.params.freeze!.value = 0;
    await ctx.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inspectSnapshot(await node.snapshot()).slots.count).not.toEqual({
      kind: "state",
      type: "f32",
      value: 0,
    });
    const restoring = node.restore(saved);
    const deadline = performance.now() + 100;
    while (performance.now() < deadline) {
      /* Keep the acknowledgement queued while audio renders. */
    }
    expect((await restoring).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inspectSnapshot(await node.snapshot()).slots.count).toEqual({
      kind: "state",
      type: "f32",
      value: 0,
    });
  } finally {
    node.dispose();
    mute.disconnect();
    await ctx.close();
  }
});
