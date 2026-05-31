/**
 * Browser e2e: message<T> 経 路 全 behavior。 main 側 で `node.events.<name>.emit(p)`
 * 送 信 + worklet onReceive で state 反 映 + state.publish で main 側 観 測 + overflow
 * + diagnostics 担 保。
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

test("message: send + worklet onReceive で state 反 映 + main で 観 測 可", async () => {
  // main で `node.events.setCount.emit({ value: 42 })` 送 信 → worklet drain で
  // counter state に 42 store → state.publish (= rateFps 30) で SAB 経 由 で main 観 測。
  // 32 quantum (= 4096 sample ≈ publish threshold 1600 越 え) で publish 反 映。
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

test("message: subscribe handler で counter 反 映 を rAF tick で 受 領", async () => {
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

test("message: 複 数 send が registration order で drain", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.events["setCount"].emit;
  sender({ value: 1 });
  sender({ value: 2 });
  sender({ value: 3 });
  await ctx.startRendering();
  // drain で 1 → 2 → 3 の 順 で store = 最 終 state = 3
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(3);
  node.dispose();
});

test("message: overflow path で diagnostics.overflowCount が 増 加", async () => {
  // capacity 256 (= default)、 257 件 send で drop-oldest 発 動。
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

test("message: send ナ シ で counter = 初 期 0 維 持 (= regression)", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  await ctx.startRendering();
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(0);
  node.dispose();
});

test("message: dispose 後 send で 例 外 出 ず (= no-op)", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  node.dispose();
  // dispose 後 send = node 既 切 断 = SAB write は 走 る が consumer ナ シ = 例 外 ナ シ path
  const sender = node.events["setCount"].emit;
  expect(() => sender({ value: 99 })).not.toThrow();
});
