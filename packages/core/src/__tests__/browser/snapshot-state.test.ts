import { flushBoundaryTrace } from "./fixtures/boundary-trace-flush.ts";
import { BoundaryTrace, boundaryContexts } from "../../restoreBoundaryTrace.ts";
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
  const trace = new BoundaryTrace(256);
  boundaryContexts.set(ctx, trace);
  let nativeFreeze: AudioParam | undefined;
  const mark = (phase: number): void =>
    trace.record(
      phase,
      trace.requestId,
      ctx.currentTime,
      ctx.state === "running" ? 1 : ctx.state === "suspended" ? 2 : 3,
      NaN,
      nativeFreeze?.value ?? NaN,
      0,
      NaN,
      NaN,
    );
  mark(40);
  await ctx.suspend();
  mark(41);
  const node = await createNode(ctx, frozenCounter);
  nativeFreeze = node.params.freeze;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.outputs.main!.connect(mute);
  mute.connect(ctx.destination);
  const start = document.createElement("button");
  start.textContent = "Start restore reproduction";
  document.body.append(start);
  try {
    const saved = await node.snapshot();
    mark(48);
    node.params.freeze!.value = 0;
    mark(49);
    const resumed = new Promise<void>((resolve, reject) => {
      start.addEventListener("click", () => void ctx.resume().then(resolve, reject), {
        once: true,
      });
    });
    await userEvent.click(start);
    await resumed;
    mark(50);
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
    mark(48);
    node.params.freeze!.value = 0;
    mark(49);
    await new Promise((resolve) => setTimeout(resolve, 30));
    mark(42);
    const crossingSuspension = node.restore(saved);
    mark(43);
    await ctx.suspend();
    mark(44);
    expect((await crossingSuspension).ok).toBe(true);
    mark(45);
    await ctx.resume();
    mark(46);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inspectSnapshot(await node.snapshot()).slots.count).toEqual({
      kind: "state",
      type: "f32",
      value: 0,
    });
  } finally {
    try {
      mark(47);
      // Flush only after the original assertions; no worklet egress during measurement.
      const workletTrace = await flushBoundaryTrace(node.node.port);
      console.log(
        "RESTORE_BOUNDARY_TRACE",
        JSON.stringify({
          sampleRate: ctx.sampleRate,
          transport: node.diagnostics.transport,
          userAgent: navigator.userAgent,
          main: {
            rows: Array.from(trace.rows.subarray(0, trace.used * 9)),
            used: trace.used,
            dropped: trace.dropped,
          },
          worklet: workletTrace,
        }),
      );
    } catch {
      // Diagnostic failures must not replace assertions or skip original cleanup.
    } finally {
      boundaryContexts.delete(ctx);
      node.dispose();
      mute.disconnect();
      start.remove();
      await ctx.close();
    }
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
