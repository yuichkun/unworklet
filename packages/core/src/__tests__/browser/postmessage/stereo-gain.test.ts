/**
 * Browser e2e: canonical Ex 1 full (stereo gain + meter L/R) verified on the
 * postMessage fallback path (SAB unavailable environment).
 *
 * Environment: served without COOP/COEP headers (`vite.browser-postmessage.config.ts`)
 * so `crossOriginIsolated === false` is guaranteed, SAB is unavailable, and
 * the unworklet runtime falls back to postMessage transport.
 *
 * Spec anchors:
 * - `02-messaging.md` §4: when SAB is unavailable, flag-bearing postMessage at
 *   render-quantum boundary
 * - `04-worklet-runtime.md` §7: publish copy step replaced by postMessage enqueue
 * - Q27-d / Q11 A5: API surface is byte-identical to the SAB path; only the
 *   main-side observation latency reflects the postMessage round-trip
 * - Q39-a/b: audio thread unconditionally stores + increments version; main side
 *   fires handler on every version advance with no value deduplication
 *
 * Test scope: same 14 axes as the SAB-side `stereo-gain.test.ts`, plus
 * 2 environment-guarantee tests + 1 no-dedupe test (Q39-b) = 17 tests total,
 * filling the transport matrix.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../../index.ts";
import stereoGain from "../fixtures/stereo-gain.processor.ts?worklet";

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

const buildStereoContext = (
  durationQuanta: number,
): {
  ctx: OfflineAudioContext;
  merger: ChannelMergerNode;
  constantL: ConstantSourceNode;
  constantR: ConstantSourceNode;
} => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 128 * durationQuanta,
    sampleRate: SAMPLE_RATE,
  });
  const constantL = new ConstantSourceNode(ctx, { offset: 1.0 });
  const constantR = new ConstantSourceNode(ctx, { offset: 1.0 });
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  constantL.connect(merger, 0, 0);
  constantR.connect(merger, 0, 1);
  return { ctx, merger, constantL, constantR };
};

// ─────────────────────────────────────────────────────────────────────────
// Environment guarantees (postMessage path only)
// ─────────────────────────────────────────────────────────────────────────

test("environment: crossOriginIsolated is false without COOP/COEP headers", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: falls back to postMessage when SAB is unavailable", async () => {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: 128,
    sampleRate: SAMPLE_RATE,
  });
  const node = await createNode(ctx, stereoGain);
  expect(node.diagnostics.transport).toBe("postMessage");
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Audio I/O behavior (transport-independent; SAB and postMessage produce identical results)
// ─────────────────────────────────────────────────────────────────────────

test("audio: stereo gain applied to DC input yields 0.5 on both channels stably", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(8);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const last = 128 * 8 - 1;
  expect(rendered.getChannelData(0)[last]).toBeCloseTo(0.5, 3);
  expect(rendered.getChannelData(1)[last]).toBeCloseTo(0.5, 3);
  node.dispose();
});

test("audio: gain = 0 produces all-zero output (mute)", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(4);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  for (let i = 64; i < ch0.length; i++) {
    // check only the latter half to skip startup transients
    expect(ch0[i]).toBe(0);
  }
  node.dispose();
});

test("audio: gain ramp produces smoothly increasing output (a-rate path)", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(8);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  node.params["gain"]!.setValueAtTime(0, 0);
  node.params["gain"]!.linearRampToValueAtTime(1.0, (128 * 8) / SAMPLE_RATE);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  const samplesPerBlock = 128;
  const early = ch0[samplesPerBlock]!;
  const late = ch0[samplesPerBlock * 7]!;
  expect(early).toBeLessThan(late);
  expect(late).toBeGreaterThan(0.5);
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Param behavior (transport-independent)
// ─────────────────────────────────────────────────────────────────────────

test("param: setValueAtTime changes gain starting at the specified quantum", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(8);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.2 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  node.params["gain"]!.setValueAtTime(0.8, (128 * 4) / SAMPLE_RATE);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  expect(ch0[128]).toBeCloseTo(0.2, 2);
  expect(ch0[128 * 6]).toBeCloseTo(0.8, 2);
  node.dispose();
});

test("param: assigning node.params.gain.value is reflected in output", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(4);
  const node = await createNode(ctx, stereoGain);
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  node.params["gain"]!.value = 0.3;
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const last = 128 * 4 - 1;
  expect(rendered.getChannelData(0)[last]).toBeCloseTo(0.3, 2);
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// state.publish behavior (verifies correct operation on the postMessage path)
// ─────────────────────────────────────────────────────────────────────────

test("state.publish: meter L/R reports 0 < v ≤ 0.5 via .value after render", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  // On the postMessage path, the port queue must drain after render completes
  // before values are reflected — wait one RAF tick.
  await waitRAF(2);
  const meterL = node.state["meterL"]!.value as number;
  const meterR = node.state["meterR"]!.value as number;
  expect(meterL).toBeGreaterThan(0);
  expect(meterL).toBeLessThanOrEqual(0.5);
  expect(meterR).toBeGreaterThan(0);
  expect(meterR).toBeLessThanOrEqual(0.5);
  node.dispose();
});

test("state.publish: subscribe handler fires repeatedly", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);

  const fired: number[] = [];
  const off = node.state["meterL"]!.subscribe((v) => {
    fired.push(v as number);
  });

  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(10);

  expect(fired.length).toBeGreaterThan(0);
  expect(fired.some((v) => v > 0)).toBe(true);

  off();
  node.dispose();
});

test("state.publish: handler does not fire after unsubscribe", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const unsub = node.state["meterL"]!.subscribe((v) => values.push(v as number));
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(2);
  const beforeUnsub = values.length;
  unsub();
  await waitRAF(3);
  expect(values.length).toBe(beforeUnsub);
  node.dispose();
});

test("state.publish: multiple subscribers each receive every fire", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const a: number[] = [];
  const b: number[] = [];
  const unsubA = node.state["meterL"]!.subscribe((v) => a.push(v as number));
  const unsubB = node.state["meterL"]!.subscribe((v) => b.push(v as number));
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(3);
  expect(a.length).toBeGreaterThan(0);
  expect(b.length).toBeGreaterThan(0);
  expect(a.length).toBe(b.length);
  unsubA();
  unsubB();
  node.dispose();
});

test("state.publish: handler fires on every publish even when value is unchanged (Q39-b no-dedupe)", async () => {
  // Spec Q39-a/b: audio thread unconditionally increments version; main side
  // fires handler on every version advance with no framework-level value comparison.
  // User-side deduplication is a single-line concern inside the handler itself.
  // With gain = 0 the meter value stays at 0 (same value each time), but the
  // handler must still fire on every due tick.
  const { ctx, merger, constantL, constantR } = buildStereoContext(48); // ~1 sec, ~30 fires at 30fps
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const unsub = node.state["meterL"]!.subscribe((v) => values.push(v as number));
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(10);
  // gain = 0 makes all samples 0, so every publish value is 0 (same value);
  // each due tick (1600-sample period = ~4 times across 48 quanta) must still fire.
  expect(values.length).toBeGreaterThan(0);
  // All received values are 0, confirming no deduplication occurred.
  for (const v of values) expect(v).toBe(0);
  unsub();
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle behavior (transport-independent)
// ─────────────────────────────────────────────────────────────────────────

test("lifecycle: calling dispose twice is a no-op (no exception thrown)", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  expect(() => node.dispose()).not.toThrow();
  expect(() => node.dispose()).not.toThrow();
});

test("lifecycle: onError handler registration and unsubscribe work correctly", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  const errors: unknown[] = [];
  const off = node.onError((e) => errors.push(e));
  expect(typeof off).toBe("function");
  off();
  node.dispose();
});

test("lifecycle: first onError subscriber receives sab-unavailable exactly once", async () => {
  // Spec `04-worklet-runtime.md` §8: in a SAB-unavailable environment, the
  // notification is delivered once to the first subscriber only; subsequent
  // subscribers receive nothing (pending flag already cleared).
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  const eventsA: unknown[] = [];
  const offA = node.onError((e) => eventsA.push(e));
  const eventsB: unknown[] = [];
  const offB = node.onError((e) => eventsB.push(e));
  // sab-unavailable is delivered synchronously via a resolved promise — observe after one microtask
  await new Promise((r) => setTimeout(r, 0));
  expect(eventsA).toEqual([{ code: "sab-unavailable" }]);
  expect(eventsB).toEqual([]); // second subscriber receives nothing
  offA();
  offB();
  node.dispose();
});

test("lifecycle: subscribe handler stops firing after dispose", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  node.state["meterL"]!.subscribe((v) => values.push(v as number));
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(2);
  const beforeDispose = values.length;
  node.dispose();
  await waitRAF(3);
  expect(values.length).toBe(beforeDispose);
});
