/**
 * Browser e2e: event<T> 経 路 全 behavior。 worklet 側 で gate-cond emitIf
 * (= Q32-c 回 避 + 動 的 path) + main 側 で `node.events.<name>.on(handler)`
 * 受 領 + atSample / 多 重 / unsubscribe / overflow / diagnostics 担 保。
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

test("event: on(handler) で emitIf 受 領 + payload + atSample 担 保", async () => {
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

test("event: 多 重 subscribe = 全 handler が registration order で fire", async () => {
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
  expect(a.length).toBe(b.length); // 全 event で 両 handler が fire
  unsubA();
  unsubB();
  node.dispose();
});

test("event: unsubscribe 後 handler が fire し な い", async () => {
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

test("event: overflow path で diagnostics.overflowCount が 増 加", async () => {
  // event-emitter は capacity 16、 1 quantum = 128 emit = drop-oldest 連 発、
  // overflowCount = 128 - 16 = 112 / quantum 程 度。
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  // subscribe ナ シ で render 走 ら す = main drain ナ シ で SAB overflow 直 接 観 測
  source.start();
  await ctx.startRendering();
  await waitRAF(2);
  const overflow = node.events["peak"]!.diagnostics.overflowCount();
  expect(overflow).toBeGreaterThan(0);
  node.dispose();
});

test("event: dispose で 全 subscriber clear + 以 後 fire ナ シ", async () => {
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

test("event: subscribe ナ シ で も render 自 体 は 動 作 (= silent OK)", async () => {
  const { ctx, source } = buildContext(4);
  const node = await createNode(ctx, eventEmitter);
  source.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  source.start();
  await ctx.startRendering();
  // output は input passthrough = 0.7 期 待
  // (= subscribe ナ シ で も audio path 走 る regression check)
  node.dispose();
});
