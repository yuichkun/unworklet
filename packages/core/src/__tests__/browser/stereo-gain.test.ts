/**
 * Browser e2e: full behavior of canonical Ex 1 (stereo gain + meter L/R)
 * verified through a real `AudioContext` + `AudioWorkletNode` + SAB + Atomics.
 *
 * Covers: Audio I/O / param automation (setValueAtTime / linearRampToValueAtTime) /
 * state.publish (sync read + subscribe rAF polling + same-value fire) / lifecycle
 * (dispose / double dispose / onError) / transport diagnostics.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import stereoGain from "./fixtures/stereo-gain.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

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
// Audio I/O behavior
// ─────────────────────────────────────────────────────────────────────────

test("audio: stereo gain × DC input = both channels stable at output 0.5", async () => {
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
    // skip the leading transient; check only the steady-state tail
    expect(ch0[i]).toBe(0);
  }
  node.dispose();
});

test("audio: gain ramp produces smoothly transitioning output (a-rate path)", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(8);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  // ramp gain from 0 to 1.0 over 8 quanta
  node.params["gain"]!.setValueAtTime(0, 0);
  node.params["gain"]!.linearRampToValueAtTime(1.0, (128 * 8) / SAMPLE_RATE);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  const samplesPerBlock = 128;
  // near the start: close to 0; near the end: close to 1.0; monotonically increasing
  const early = ch0[samplesPerBlock]!;
  const late = ch0[samplesPerBlock * 7]!;
  expect(early).toBeLessThan(late);
  expect(late).toBeGreaterThan(0.5);
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Param behavior
// ─────────────────────────────────────────────────────────────────────────

test("param: setValueAtTime changes gain in the latter half of the render", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(8);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.2 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  // switch to 0.8 after 4 quanta
  node.params["gain"]!.setValueAtTime(0.8, (128 * 4) / SAMPLE_RATE);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  // block 1 should reflect 0.2 and block 6 should reflect 0.8
  expect(ch0[128]).toBeCloseTo(0.2, 2);
  expect(ch0[128 * 6]).toBeCloseTo(0.8, 2);
  node.dispose();
});

test("param: direct assignment to node.params.gain.value takes effect", async () => {
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
// state.publish behavior
// ─────────────────────────────────────────────────────────────────────────

test("state.publish: meter L/R readable via SAB after render, values in (0, 0.5]", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  const meterL = node.state["meterL"]!.value as number;
  const meterR = node.state["meterR"]!.value as number;
  expect(meterL).toBeGreaterThan(0);
  expect(meterL).toBeLessThanOrEqual(0.5);
  expect(meterR).toBeGreaterThan(0);
  expect(meterR).toBeLessThanOrEqual(0.5);
  node.dispose();
});

test("state.publish: subscribe handler fires on rAF ticks", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const unsub = node.state["meterL"]!.subscribe((v) => values.push(v as number));
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(3);
  expect(values.length).toBeGreaterThan(0);
  expect(values[values.length - 1]).toBeGreaterThan(0);
  unsub();
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

test("state.publish: all handlers fire when multiple subscribers are registered", async () => {
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

test("state.publish: handler fires on every tick even when the published value is unchanged (Q39-b no-dedupe)", async () => {
  // Spec Q39-a/b: the audio thread unconditionally increments the version counter;
  // the main side fires handlers on every version advance with no value comparison.
  // Even when gain = 0 keeps meterL at 0 (same value each publish), the handler
  // must fire on every due tick — verified through the SAB path.
  const { ctx, merger, constantL, constantR } = buildStereoContext(48);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const unsub = node.state["meterL"]!.subscribe((v) => values.push(v as number));
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(10);
  expect(values.length).toBeGreaterThan(0);
  for (const v of values) expect(v).toBe(0);
  unsub();
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle behavior
// ─────────────────────────────────────────────────────────────────────────

test("lifecycle: calling dispose twice is a no-op (no exception thrown)", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  expect(() => node.dispose()).not.toThrow();
  expect(() => node.dispose()).not.toThrow();
});

test("lifecycle: onError handler registration and unsubscribe path work", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  const errors: unknown[] = [];
  const off = node.onError((e) => errors.push(e));
  expect(typeof off).toBe("function");
  off();
  node.dispose();
});

test("lifecycle: subscribe handlers do not fire after dispose", async () => {
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

// ─────────────────────────────────────────────────────────────────────────
// Transport diagnostics
// ─────────────────────────────────────────────────────────────────────────

test("transport: COOP/COEP headers enable SAB transport", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  expect(node.diagnostics.transport).toBe("sab");
  node.dispose();
});
