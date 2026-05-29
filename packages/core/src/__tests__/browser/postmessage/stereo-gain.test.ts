/**
 * Browser e2e: canonical Ex 1 full (= stereo gain + meter L/R) を
 * postMessage fallback path で 動 作 確 認 (= SAB unavailable 環 境)。
 *
 * 環 境: COOP/COEP ヘ ッ ダ 無 し config (= `vite.browser-postmessage.config.ts`)
 * 経 由 で `crossOriginIsolated === false` 担 保 = SAB 不 可 = unworklet
 * runtime が postMessage transport に fallback。
 *
 * 仕 様 anchor:
 * - `02-messaging.md` §4: SAB 不 可 時 = flag-bearing postMessage at
 *   render-quantum boundary
 * - `04-worklet-runtime.md` §7: publish copy step を postMessage enqueue
 *   に 置 き 換 え
 * - Q27-d / Q11 A5: API surface は SAB と byte-identical、 main 側 観 測 latency
 *   だ け が postMessage round-trip を 拾 う
 * - Q39-a/b: audio thread = 無 条 件 store + 版 inc、 main side = 版 advance で
 *   handler 必 ず fire (= framework 値 比 較 ナ シ)
 *
 * test scope = SAB 側 `stereo-gain.test.ts` と 同 14 軸 + postMessage 環 境 担 保
 * 2 + no-dedupe (= Q39-b) 1 = 17 test、 transport mtx を fill。
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
// 環 境 担 保 (= postMessage path 専 属)
// ─────────────────────────────────────────────────────────────────────────

test("環 境 担 保: COOP/COEP 無 し で crossOriginIsolated false", () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
});

test("transport: SAB unavailable で postMessage に fallback", async () => {
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
// Audio I/O behavior (= transport non-dependent、 SAB / postMessage 同 結 果)
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
// Param behavior (= transport non-dependent)
// ─────────────────────────────────────────────────────────────────────────

test("param: setValueAtTime で 後 半 quantum の gain 変 化", async () => {
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
// state.publish behavior (= postMessage path で 仕 様 通 り 動 く か)
// ─────────────────────────────────────────────────────────────────────────

test("state.publish: meter L/R = render 後 .value で 0 < v ≤ 0.5", async () => {
  const { ctx, merger, constantL, constantR } = buildStereoContext(32);
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0.5 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  // postMessage path は render 完 了 後 に port queue が drain さ れ て 値 が
  // 反 映 さ れ る 必 要 = await waitRAF で 1 tick 待 つ。
  await waitRAF(2);
  const meterL = node.state["meterL"]!.value as number;
  const meterR = node.state["meterR"]!.value as number;
  expect(meterL).toBeGreaterThan(0);
  expect(meterL).toBeLessThanOrEqual(0.5);
  expect(meterR).toBeGreaterThan(0);
  expect(meterR).toBeLessThanOrEqual(0.5);
  node.dispose();
});

test("state.publish: subscribe 経 路 で handler が 連 続 fire", async () => {
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

test("state.publish: 同 値 publish で も handler 連 続 fire (= Q39-b no-dedupe)", async () => {
  // 仕 様 Q39-a/b: audio thread = 無 条 件 inc、 main side = 版 advance で
  // framework 値 比 較 ナ シ で handler 必 ず fire。 user dedupe は handler 内 1 行。
  // gain = 0 で meter 値 = 0 の ま ま (= 同 値) で も 各 due tick で fire す る こ と
  // を 観 測。
  const { ctx, merger, constantL, constantR } = buildStereoContext(48); // 1 sec 弱 = 30fps で 30 fire 予 定
  const node = await createNode(ctx, stereoGain, { initial: { gain: 0 } });
  merger.connect(node.inputs["main"]!);
  node.outputs["main"]!.connect(ctx.destination);
  const values: number[] = [];
  const unsub = node.state["meterL"]!.subscribe((v) => values.push(v as number));
  constantL.start();
  constantR.start();
  await ctx.startRendering();
  await waitRAF(10);
  // gain = 0 で 全 sample 0 = 全 publish 値 0 (= 同 値)、 ただ し 各 due tick
  // (= 1600 sample 周 期 = 48 quanta 中 約 4 回) で 必 ず fire = 1 件 以 上 受 信。
  expect(values.length).toBeGreaterThan(0);
  // 全 件 0 を 観 測 (= 同 値 dedupe さ れ て な い = framework 値 比 較 ナ シ 担 保)。
  for (const v of values) expect(v).toBe(0);
  unsub();
  node.dispose();
});

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle behavior (= transport non-dependent)
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

test("lifecycle: onError 登 録 で sab-unavailable event を 1 度 だ け 受 信", async () => {
  // 仕 様 `04-worklet-runtime.md` §8: SAB 不 可 環 境 で 1 番 目 の subscriber に
  // 1 度 だ け 通 知、 2 番 目 以 降 は drop (= pending flag clear 済)。
  const { ctx } = buildStereoContext(1);
  const node = await createNode(ctx, stereoGain);
  const eventsA: unknown[] = [];
  const offA = node.onError((e) => eventsA.push(e));
  const eventsB: unknown[] = [];
  const offB = node.onError((e) => eventsB.push(e));
  // subscribe 即 時 に sab-unavailable を 受 信 = sync な promise.resolve 後 観 測
  await new Promise((r) => setTimeout(r, 0));
  expect(eventsA).toEqual([{ code: "sab-unavailable" }]);
  expect(eventsB).toEqual([]); // 2 番 目 subscriber は drop
  offA();
  offB();
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
