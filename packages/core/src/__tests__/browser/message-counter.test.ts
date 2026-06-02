/**
 * Browser e2e: full message<T> path behavior. Main thread sends via
 * `node.events.<name>.emit(p)`, worklet onReceive reflects state,
 * state.publish exposes it to the main thread; overflow and diagnostics
 * are also covered.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import messageCounter from "./fixtures/message-counter.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

const waitRAF = (ticks: number): Promise<void> =>
  new Promise<void>((resolve) => {
    let n = 0;
    const wait = (): void => {
      n += 1;
      if (n >= ticks) {
        resolve();
        return;
      }
      requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  });

const buildContext = (durationQuanta: number): OfflineAudioContext =>
  new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * durationQuanta,
    sampleRate: SAMPLE_RATE,
  });

// ─────────────────────────────────────────────────────────────────────────
// message<T> behavior
// ─────────────────────────────────────────────────────────────────────────

test("message: send + worklet onReceive reflects state, observable from main thread", async () => {
  // Main thread emits `node.events.setCount.emit({ value: 42 })`. The worklet
  // drains the queue and stores 42 in counter state. state.publish (rateFps 30)
  // propagates it via SAB to the main thread.
  // 32 quanta (= 4096 samples, exceeds the publish threshold of 1600) ensures
  // the published value is visible.
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.events["setCount"].emit;
  sender({ value: 42 });
  await ctx.startRendering();
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(42);
  node.dispose();
});

test("message: subscribe handler receives counter update within rAF ticks", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const off = node.state["counter"]!.subscribe((v) => values.push(v as number));
  const sender = node.events["setCount"].emit;
  sender({ value: 7 });
  await ctx.startRendering();
  await waitRAF(3);
  expect(values).toContain(7);
  off();
  node.dispose();
});

test("message: multiple sends are drained in registration order", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.events["setCount"].emit;
  sender({ value: 1 });
  sender({ value: 2 });
  sender({ value: 3 });
  await ctx.startRendering();
  // Drained in order 1 → 2 → 3; final state is 3.
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(3);
  node.dispose();
});

test("message: overflow path increments diagnostics.overflowCount", async () => {
  // Default capacity is 256; sending 257 messages triggers drop-oldest.
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.events["setCount"].emit;
  for (let i = 0; i < 257; i++) {
    sender({ value: i });
  }
  const diag = node.events["setCount"].diagnostics;
  expect(diag.overflowCount()).toBeGreaterThan(0);
  node.dispose();
});

test("message: counter stays at initial value 0 when no messages are sent (regression)", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  await ctx.startRendering();
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(0);
  node.dispose();
});

test("message: send after dispose does not throw (no-op)", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  node.dispose();
  // After dispose, the node is disconnected. SAB writes still execute, but there
  // is no consumer — the path must not throw.
  const sender = node.events["setCount"].emit;
  expect(() => sender({ value: 99 })).not.toThrow();
});
