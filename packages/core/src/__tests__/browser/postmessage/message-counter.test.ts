/**
 * Browser e2e: message<T> 経 路 を postMessage fallback path で 動 作 確 認
 * (= SAB unavailable 環 境)。
 *
 * 仕 様 anchor:
 * - `02-messaging.md` §4 + Q27-d: SAB 不 可 時 = message<T> も postMessage 経 路
 * - `04-worklet-runtime.md` §2 step 1: per-quantum 開 始 で 全 handler drain
 *   (= Q38-b)、 transport 非 依 存 で 同 surface
 * - Q47: diagnostics.overflowCount は pull 観 測 = transport 非 依 存
 *
 * test scope = SAB 側 `message-counter.test.ts` と 同 6 件 mirror + 環 境 担 保
 * 2 件 = 8 件。 send / 多 重 send / overflow / counter publish 反 映 / dispose 後
 * send 例 外 ナ シ を 両 transport で 同 surface で 担 保。
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import messageCounter from "../fixtures/message-counter.processor.ts?worklet";

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
// 環 境 担 保 (= postMessage path 専 属)
// ─────────────────────────────────────────────────────────────────────────

test("環 境 担 保: COOP/COEP 無 し で crossOriginIsolated false", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: SAB unavailable で postMessage に fallback", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// message<T> behavior (= SAB 側 6 件 mirror)
// ─────────────────────────────────────────────────────────────────────────

test("message: send + worklet onReceive で state 反 映 + main で 観 測 可", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.messages["setCount"] as (p: { value: number }) => void;
  sender({ value: 42 });
  await ctx.startRendering();
  await waitRAF(2);
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(42);
  node.dispose();
});

test("message: subscribe handler で counter 反 映 を 受 領", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const off = node.state["counter"]!.subscribe((v) => values.push(v as number));
  const sender = node.messages["setCount"] as (p: { value: number }) => void;
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
  const sender = node.messages["setCount"] as (p: { value: number }) => void;
  sender({ value: 1 });
  sender({ value: 2 });
  sender({ value: 3 });
  await ctx.startRendering();
  await waitRAF(2);
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(3);
  node.dispose();
});

test("message: overflow path で diagnostics.overflowCount が 増 加", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.messages["setCount"] as (p: { value: number }) => void;
  for (let i = 0; i < 257; i++) {
    sender({ value: i });
  }
  const diag = (node.messages["setCount"] as { diagnostics: { overflowCount(): number } })
    .diagnostics;
  expect(diag.overflowCount()).toBeGreaterThan(0);
  node.dispose();
});

test("message: send ナ シ で counter = 初 期 0 維 持 (= regression)", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  await ctx.startRendering();
  await waitRAF(2);
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(0);
  node.dispose();
});

test("message: dispose 後 send で 例 外 出 ず (= no-op)", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  node.dispose();
  const sender = node.messages["setCount"] as (p: { value: number }) => void;
  expect(() => sender({ value: 99 })).not.toThrow();
});
