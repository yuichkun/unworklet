import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createNode, inspectSnapshot, replaceProcessor } from "../../index.ts";
import automationProcessor from "./fixtures/restore-automation.processor.ts?worklet";
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
  const start = document.createElement("button");
  start.textContent = "Start restore reproduction";
  document.body.append(start);
  const observations: Array<Record<string, unknown>> = [];
  const observe = (phase: string, slots?: unknown): void => {
    const currentTime = ctx.currentTime;
    observations.push({
      phase,
      currentTime,
      frameProduct: currentTime * ctx.sampleRate,
      contextState: ctx.state,
      sampleRate: ctx.sampleRate,
      freeze: node.params.freeze!.value,
      automationRate: node.params.freeze!.automationRate,
      slots,
    });
  };
  try {
    const saved = await node.snapshot();
    observe("saved-before-rendering", inspectSnapshot(saved).slots);
    node.params.freeze!.value = 0;
    const resumed = new Promise<void>((resolve, reject) => {
      start.addEventListener("click", () => void ctx.resume().then(resolve, reject), {
        once: true,
      });
    });
    await userEvent.click(start);
    await resumed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const advancing = inspectSnapshot(await node.snapshot());
    observe("before-live-restore", advancing.slots);
    expect(advancing.slots.count).not.toEqual({
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
    observe("live-restore-resolved");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterLive = inspectSnapshot(await node.snapshot());
    observe("after-live-restore", afterLive.slots);
    expect(afterLive.slots.count).toEqual({
      kind: "state",
      type: "f32",
      value: 0,
    });
    node.params.freeze!.value = 0;
    await new Promise((resolve) => setTimeout(resolve, 30));
    observe("before-crossing-restore-call");
    const crossingSuspension = node.restore(saved);
    observe("before-immediate-suspend-request");
    await ctx.suspend();
    observe("suspend-resolved");
    expect((await crossingSuspension).ok).toBe(true);
    observe("crossing-restore-resolved-before-resume");
    await ctx.resume();
    observe("resume-resolved");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterResume = inspectSnapshot(await node.snapshot());
    observe("after-resume", afterResume.slots);
    expect(afterResume.slots.count).toEqual({
      kind: "state",
      type: "f32",
      value: 0,
    });
  } finally {
    console.log(
      "SNAPSHOT_BOUNDARY_OBSERVATIONS " +
        JSON.stringify({
          crossOriginIsolated,
          userAgent: navigator.userAgent,
          suspendRequest: "AudioContext.suspend() without requested time",
          observations,
        }),
    );
    node.dispose();
    mute.disconnect();
    start.remove();
    await ctx.close();
  }
});

test("restore preserves scheduled steps, a-rate ramps and connected modulation while suspended", async () => {
  const ctx = new OfflineAudioContext(1, 128 * 10, 48000);
  const node = await createNode(ctx, automationProcessor);
  const modulation = new ConstantSourceNode(ctx, { offset: 0.125 });
  modulation.connect(node.params.gain!);
  node.outputs.main!.connect(ctx.destination);
  try {
    const saved = await node.snapshot();
    node.params.gain!.value = 0.75;
    node.params.gain!.setValueAtTime(0.5, (128 * 4) / 48000);
    node.params.gain!.linearRampToValueAtTime(1, (128 * 8) / 48000);
    modulation.start();
    const suspended = ctx.suspend((128 * 2) / 48000);
    const rendering = ctx.startRendering();
    await suspended;
    expect((await node.restore(saved)).ok).toBe(true);
    expect(inspectSnapshot(await node.snapshot()).slots.gain).toEqual({
      kind: "param",
      value: 0.25,
    });
    await ctx.resume();
    const samples = (await rendering).getChannelData(0);
    expect(samples[128]).toBeCloseTo(2.875, 5);
    expect(samples[128 * 2]).toBeCloseTo(2.375, 5);
    expect(samples[128 * 4]).toBeCloseTo(2.625, 5);
    expect(samples[128 * 6]).toBeCloseTo(2.875, 5);
    expect(samples[128 * 6 + 64]).toBeCloseTo(2.9375, 5);
    expect(samples[128 * 9]).toBeCloseTo(3.125, 5);
  } finally {
    node.dispose();
    modulation.disconnect();
  }
});
