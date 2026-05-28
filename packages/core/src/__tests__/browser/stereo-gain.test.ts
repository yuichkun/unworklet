/**
 * Browser e2e: canonical Ex 1 full (= stereo gain + meter L/R) の 全 behavior
 * を real `AudioContext` + `AudioWorkletNode` + SAB + Atomics 経 由 で 検 証。
 *
 * cover: Audio I/O / param 操 作 (= setValueAtTime / linearRampToValueAtTime) /
 * state.publish (= sync read + subscribe rAF polling + 同 値 fire) / lifecycle
 * (= dispose / 2 度 dispose / onError) / transport diagnostics。
 */

import { expect, test } from "vitest";

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

test("audio: stereo gain × DC input = output 0.5 で 両 channel 安 定", async () => {
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

test("audio: gain = 0 で output が 全 sample 0 (= mute)", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(4);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  for (let i = 64; i < ch0.length; i++) {
    // 立 ち 上 が り transient を 避 け て 後 半 だ け check
    expect(ch0[i]).toBe(0);
  }
  node.dispose();
});

test("audio: gain ramp で output が 滑 ら か に 推 移 (= a-rate path 担 保)", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(8);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  // 0 → 1.0 を 8 quantum 分 か け て ramp
  node.params["gain"]!.setValueAtTime(0, 0);
  node.params["gain"]!.linearRampToValueAtTime(1.0, (128 * 8) / SAMPLE_RATE);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  const samplesPerBlock = 128;
  // 開 始 付 近 = 0 寄 り、 末 尾 付 近 = 1.0 寄 り、 単 調 増 加
  const early = ch0[samplesPerBlock]!;
  const late = ch0[samplesPerBlock * 7]!;
  expect(early).toBeLessThan(late);
  expect(late).toBeGreaterThan(0.5);
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Param behavior
// ─────────────────────────────────────────────────────────────────────────

test("param: setValueAtTime で 後 半 quantum の gain 変 化", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(8);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.2 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  // 4 quantum 後 に 0.8 へ
  node.params["gain"]!.setValueAtTime(0.8, (128 * 4) / SAMPLE_RATE);
  constantL.start();
  constantR.start();
  const rendered = await ctx.startRendering();
  const ch0 = rendered.getChannelData(0);
  // block 1 (= 0.2) と block 6 (= 0.8) で 差 が 出 る
  expect(ch0[128]).toBeCloseTo(0.2, 2);
  expect(ch0[128 * 6]).toBeCloseTo(0.8, 2);
  node.dispose();
});

test("param: node.params.gain.value で 直 接 set + 反 映", async () => {
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

test("state.publish: meter L/R = render 後 SAB 経 由 で 0 < v ≤ 0.5", async () => {
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

test("state.publish: subscribe handler が rAF tick で fire", async () => {
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

test("state.publish: unsubscribe 後 handler が fire し な い", async () => {
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

test("state.publish: 多 重 subscribe で 全 handler fire", async () => {
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

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle behavior
// ─────────────────────────────────────────────────────────────────────────

test("lifecycle: dispose 後 2 度 呼 ぶ で no-op (= 例 外 出 ず)", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  expect(() => node.dispose()).not.toThrow();
  expect(() => node.dispose()).not.toThrow();
});

test("lifecycle: onError handler 登 録 + unsubscribe path 動 く", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  const errors: unknown[] = [];
  const off = node.onError((e) => errors.push(e));
  expect(typeof off).toBe("function");
  off();
  node.dispose();
});

test("lifecycle: dispose で subscribe handler が 以 後 fire し な い", async () => {
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

test("transport: COOP/COEP 経 由 で sab", async () => {
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  expect(node.diagnostics.transport).toBe("sab");
  node.dispose();
});
