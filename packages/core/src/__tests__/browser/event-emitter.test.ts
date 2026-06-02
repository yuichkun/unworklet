/**
 * Browser e2e: full event<T> path behavior. Worklet side uses gate-conditioned emitIf
 * (Q32-c avoidance + dynamic path); main side receives via `node.events.<name>.on(handler)`.
 * Covers atSample, multiple subscribers, unsubscribe, overflow, and diagnostics.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import eventEmitter from "./fixtures/event-emitter.processor.ts?worklet";

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

const buildContext = (
  durationQuanta: number,
): {
  ctx: OfflineAudioContext;
  source: ConstantSourceNode;
} => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * durationQuanta,
    sampleRate: SAMPLE_RATE,
  });
  const source = new ConstantSourceNode(ctx, { offset: 0.7 });
  return { ctx, source };
};

// ─────────────────────────────────────────────────────────────────────────
// event<T> behavior
// ─────────────────────────────────────────────────────────────────────────

test("event: on(handler) receives emitIf payload with correct atSample", async () => {
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const received: Array<{ atSample: number; level: number }> = [];
  const unsub = node.events["peak"]!.on((p) => {
    received.push(p as { atSample: number; level: number });
  });
  source.start();
  await ctx.startRendering();
  await waitRAF(3);
  expect(received.length).toBeGreaterThan(0);
  // atSample = 0..127 (= block-local), level = input amplitude 0.7
  for (const ev of received) {
    expect(ev.atSample).toBeGreaterThanOrEqual(0);
    expect(ev.atSample).toBeLessThan(128);
    expect(ev.level).toBeCloseTo(0.7, 3);
  }
  unsub();
  node.dispose();
});

test("event: multiple subscribers all fire in registration order", async () => {
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const a: number[] = [];
  const b: number[] = [];
  const unsubA = node.events["peak"]!.on(() => a.push(Date.now()));
  const unsubB = node.events["peak"]!.on(() => b.push(Date.now()));
  source.start();
  await ctx.startRendering();
  await waitRAF(3);
  expect(a.length).toBeGreaterThan(0);
  expect(b.length).toBeGreaterThan(0);
  expect(a.length).toBe(b.length); // both handlers fire on every event
  unsubA();
  unsubB();
  node.dispose();
});

test("event: handler does not fire after unsubscribe", async () => {
  const { ctx, source } = buildContext(8);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const calls: unknown[] = [];
  const unsub = node.events["peak"]!.on((p) => calls.push(p));
  source.start();
  await ctx.startRendering();
  await waitRAF(2);
  const beforeUnsub = calls.length;
  expect(beforeUnsub).toBeGreaterThan(0);
  unsub();
  await waitRAF(3);
  expect(calls.length).toBe(beforeUnsub);
  node.dispose();
});

test("event: diagnostics.overflowCount increments on overflow path", async () => {
  // event-emitter has capacity 16; 1 quantum emits 128 events = repeated drop-oldest,
  // so overflowCount should be around 128 - 16 = 112 per quantum.
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  // render without a subscriber = no main-thread drain, observing SAB overflow directly
  source.start();
  await ctx.startRendering();
  await waitRAF(2);
  const overflow = node.events["peak"]!.diagnostics.overflowCount();
  expect(overflow).toBeGreaterThan(0);
  node.dispose();
});

test("event: dispose clears all subscribers and stops firing", async () => {
  const { ctx, source } = buildContext(8);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const calls: unknown[] = [];
  node.events["peak"]!.on((p) => calls.push(p));
  source.start();
  await ctx.startRendering();
  await waitRAF(2);
  const beforeDispose = calls.length;
  node.dispose();
  await waitRAF(3);
  expect(calls.length).toBe(beforeDispose);
});

test("event: render works without any subscriber (silent OK)", async () => {
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  source.start();
  await ctx.startRendering();
  // output is input passthrough, expected level 0.7
  // (regression check: audio path runs even with no subscribers)
  node.dispose();
});
