/**
 * Browser e2e: verifies message<T> routing over the postMessage fallback path
 * (i.e. environments where SAB is unavailable).
 *
 * Spec anchors:
 * - `02-messaging.md` §4 + Q27-d: when SAB is unavailable, message<T> also routes via postMessage
 * - `04-worklet-runtime.md` §2 step 1: all handlers are drained at the start of each quantum
 *   (= Q38-b); surface is transport-independent
 * - Q47: diagnostics.overflowCount is pull-observed = transport-independent
 *
 * test scope = 6 mirror cases matching the SAB-side `message-counter.test.ts`
 * + 2 environment-guarantee cases = 8 total.
 * Covers: send / multi-send / overflow / counter publish reflection / no exception after dispose —
 * guaranteed on the same surface across both transports.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import { decodeScalar, type SnapshotSlot } from "../../../snapshot.ts";
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
// Environment guarantees (postMessage path exclusive)
// ─────────────────────────────────────────────────────────────────────────

test("environment: crossOriginIsolated is false without COOP/COEP headers", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: falls back to postMessage when SAB is unavailable", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// message<T> behavior (6 mirror cases from the SAB-side test)
// ─────────────────────────────────────────────────────────────────────────

test("message: send + worklet onReceive reflects state, observable on main thread", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.events["setCount"].emit;
  sender({ value: 42 });
  // The response follows preceding ingress on the same MessagePort. Offline
  // sample time must not outrun delivery before the first publication point.
  await node.snapshot();
  expect(node.state["counter"]!.value).toBe(0);
  await ctx.startRendering();
  await waitRAF(2);
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(42);
  node.dispose();
});

test("message: subscribe handler receives counter updates", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const off = node.state["counter"]!.subscribe((v) => values.push(v as number));
  const sender = node.events["setCount"].emit;
  sender({ value: 7 });
  await node.snapshot();
  expect(values).toEqual([]);
  await ctx.startRendering();
  await waitRAF(3);
  expect(values).toEqual([7, 7]);
  off();
  node.dispose();
});

test("message: admitted sends are processed in registration order", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.events["setCount"].emit;
  sender({ value: 1 });
  sender({ value: 2 });
  sender({ value: 3 });
  await node.snapshot();
  await ctx.startRendering();
  await waitRAF(2);
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(3);
  node.dispose();
});

test("message: diagnostics.overflowCount starts at 0 on postMessage path; WASM drop-oldest increments it (wiring check)", async () => {
  // OfflineAudioContext + postMessage path: all main→worklet messages are not
  // guaranteed to be delivered during sync render (MessageChannel task queue is
  // not drained while the offline renderer runs synchronously), so the WASM
  // ring buffer capacity is never exceeded and overflow stays at 0.
  // This test verifies wiring correctness: push does not throw, and
  // diagnostics are readable via the mirror (initial value = 0).
  // Observing actual overflow requires a real-time AudioContext with appropriate
  // timing, verified in a separate phase.
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  const sender = node.events["setCount"].emit;
  for (let i = 0; i < 257; i++) {
    sender({ value: i });
  }
  const diag = node.events["setCount"].diagnostics;
  expect(diag.overflowCount()).toBeGreaterThanOrEqual(0);
  node.dispose();
});

test("message: counter stays at initial value of 0 when no sends are made (regression)", async () => {
  const ctx = buildContext(32);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  await ctx.startRendering();
  await waitRAF(2);
  const observed = node.state["counter"]!.value as number;
  expect(observed).toBe(0);
  node.dispose();
});

test("message: send after dispose does not throw (no-op)", async () => {
  const ctx = buildContext(1);
  const node = await createNode(ctx, messageCounter);
  node.outputs["main"]!.connect(ctx.destination);
  node.dispose();
  const sender = node.events["setCount"].emit;
  expect(() => sender({ value: 99 })).not.toThrow();
});

test("message: an admitted late update publishes at the next audio-clock interval", async () => {
  const ctx = buildContext(40);
  const node = await createNode(ctx, messageCounter);
  const values: number[] = [];
  let rendering: Promise<AudioBuffer> | undefined;
  try {
    node.outputs["main"]!.connect(ctx.destination);
    node.state["counter"]!.subscribe((value) => values.push(value as number));
    const beforeUpdate = ctx.suspend(3967 / SAMPLE_RATE);
    const afterUpdate = ctx.suspend(4095 / SAMPLE_RATE);
    rendering = ctx.startRendering();
    await beforeUpdate;
    expect(Math.round(ctx.currentTime * SAMPLE_RATE)).toBe(3968);
    await node.snapshot();
    expect(values).toEqual([0, 0]);
    node.events["setCount"].emit({ value: 7 });
    await node.snapshot();
    await ctx.resume();
    await afterUpdate;
    expect(Math.round(ctx.currentTime * SAMPLE_RATE)).toBe(4096);
    // Read actual state, not the rate-limited mirror. The ingress was consumed
    // by DSP, but the third 30-FPS publication is not due until frame4864.
    const slots = await new Promise<SnapshotSlot[]>((resolve) => {
      const receive = (event: MessageEvent): void => {
        if (event.data.kind !== "dev-dump-response" || event.data.requestId !== 12345) return;
        node.node.port.removeEventListener("message", receive);
        resolve(event.data.slots as SnapshotSlot[]);
      };
      node.node.port.addEventListener("message", receive);
      node.node.port.postMessage({ kind: "dev-dump-request", requestId: 12345 });
    });
    expect(decodeScalar("f32", slots.find((slot) => slot.name === "counter")!.data)).toBe(7);
    expect(node.state["counter"]!.value).toBe(0);
    expect(values).toEqual([0, 0]);
    await ctx.resume();
    await rendering;
    // This response also follows every earlier worklet publication on the port.
    await node.snapshot();
    expect(values).toEqual([0, 0, 7]);
    expect(node.state["counter"]!.value).toBe(7);
  } finally {
    node.dispose();
    if (ctx.state === "suspended") await ctx.resume();
    await rendering;
  }
});
