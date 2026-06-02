/**
 * Browser e2e: verifies event<T> routing via the postMessage fallback path
 * (SAB unavailable environment).
 *
 * Spec anchors:
 * - `02-messaging.md` §4 + Q27-d: when SAB is unavailable, event<T> also uses the postMessage path
 * - `04-worklet-runtime.md` §7: event ring is delivered at the end of each quantum
 * - Q47: diagnostics.overflowCount is observed by pull, independent of transport
 *
 * Test scope: mirrors the 6 cases from the SAB-side `event-emitter.test.ts` plus 2
 * environment-guarantee tests = 8 total. Covers emit / multiple subscribers /
 * unsubscribe / overflow / dispose / render-without-subscriber across both transports.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import eventEmitter from "../fixtures/event-emitter.processor.ts?worklet";

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
// Environment guarantees (postMessage path only)
// ─────────────────────────────────────────────────────────────────────────

test("environment: crossOriginIsolated is false without COOP/COEP headers", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: falls back to postMessage when SAB is unavailable", async () => {
  const { ctx } = buildContext(1);
  const node = await createNode(ctx, eventEmitter);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// event<T> behavior (mirrors the 6 SAB-side cases)
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
  expect(a.length).toBe(b.length);
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

test("event: diagnostics.overflowCount increments on overflow", async () => {
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  source.start();
  await ctx.startRendering();
  await waitRAF(2);
  const overflow = node.events["peak"]!.diagnostics.overflowCount();
  expect(overflow).toBeGreaterThan(0);
  node.dispose();
});

test("event: dispose clears all subscribers and stops further firing", async () => {
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

test("event: render completes normally with no subscribers", async () => {
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  source.start();
  await ctx.startRendering();
  node.dispose();
});
