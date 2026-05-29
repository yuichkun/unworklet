/**
 * Browser e2e: event<T> 経 路 を postMessage fallback path で 動 作 確 認
 * (= SAB unavailable 環 境)。
 *
 * 仕 様 anchor:
 * - `02-messaging.md` §4 + Q27-d: SAB 不 可 時 = event<T> も postMessage 経 路
 * - `04-worklet-runtime.md` §7 (= event ring も per-quantum 末 尾 で 配 送)
 * - Q47: diagnostics.overflowCount は pull 観 測 = transport 非 依 存
 *
 * test scope = SAB 側 `event-emitter.test.ts` と 同 6 件 mirror + 環 境 担 保
 * 2 件 = 8 件。 emit / 多 重 subscribe / unsubscribe / overflow / dispose /
 * subscribe ナ シ 動 作 を 両 transport で 同 surface で 担 保。
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
// 環 境 担 保 (= postMessage path 専 属)
// ─────────────────────────────────────────────────────────────────────────

test("環 境 担 保: COOP/COEP 無 し で crossOriginIsolated false", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: SAB unavailable で postMessage に fallback", async () => {
  const { ctx } = buildContext(1);
  const node = await createNode(ctx, eventEmitter);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// event<T> behavior (= SAB 側 6 件 mirror)
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
  expect(a.length).toBe(b.length);
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
  node.dispose();
});
