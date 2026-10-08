import { commands } from "vite-plus/test/browser";
import { expect, inject, test, vi } from "vite-plus/test";
import nativeRate from "virtual:native-rate-worklet";
import defaultRate from "./fixtures/stereo-gain.processor.ts?worklet";
import { createNode } from "../../index.ts";
import { observeCrossRealm, type CrossRealmEvent } from "./fixtures/crossrealm-observation.ts";

const sampleRate = 44_100;

test("native 44100: four quanta of PCM, complete events and persistent bytes match renderOffline", async () => {
  const oracle = await commands.renderCrossRealmOracle("native-rate", sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 640, sampleRate });
  expect(ctx.sampleRate).toBe(sampleRate);
  expect(nativeRate.worklet.bakedSampleRate).toBe(sampleRate);
  const node = await createNode(ctx, nativeRate);
  const received: CrossRealmEvent[] = [];
  const unsubscribe = node.events.frame!.on((raw) => {
    const { atSample, block, level } = raw as { atSample: number; block: number; level: number };
    received.push({ name: "frame", atSample, payload: { block, level } });
  });
  try {
    expect(node.diagnostics.transport).toBe(inject("nativeRateTransport"));
    node.outputs.main!.connect(ctx.destination);
    const boundaries = Array.from({ length: 4 }, (_, i) =>
      ctx.suspend(((i + 1) * 128) / sampleRate),
    );
    const rendering = ctx.startRendering();
    let state: Uint8Array = new Uint8Array();
    for (const [block, boundary] of boundaries.entries()) {
      await boundary;
      state = await node.snapshot();
      await expect.poll(() => received.length).toBe(block + 1);
      if (block < 3) await ctx.resume();
    }
    unsubscribe();
    await ctx.resume();
    const rendered = await rendering;
    const actual = observeCrossRealm([rendered.getChannelData(0).slice(0, 512)], received, state);
    expect(actual).toEqual(oracle);
    const value = (n: number) => Math.fround(n * Math.fround(1 / sampleRate));
    const expected = Float32Array.from({ length: 512 }, (_, i) => value(i + 1));
    expect(actual.pcm).toEqual([Array.from(new Uint32Array(expected.buffer))]);
    expect(actual.events).toEqual(
      Array.from({ length: 4 }, (_, i) => ({
        name: "frame",
        atSample: 127,
        payload: { block: i + 1, level: value((i + 1) * 128) },
      })),
    );
    expect(actual.snapshot.slots).toEqual([
      { name: "blocks", kind: "state", type: "i32", data: [4, 0, 0, 0] },
      { name: "counter", kind: "state", type: "i32", data: [0, 2, 0, 0] },
      {
        name: "last",
        kind: "state",
        type: "f32",
        data: Array.from(new Uint8Array(new Float32Array([value(512)]).buffer)),
      },
    ]);
    const wrongRate = Float32Array.from({ length: 512 }, (_, i) =>
      Math.fround((i + 1) * Math.fround(1 / 48_000)),
    );
    expect(actual.pcm[0]).not.toEqual(Array.from(new Uint32Array(wrongRate.buffer)));
  } finally {
    unsubscribe();
    node.dispose();
  }
});

test("native 44100: honest 48000 ?worklet artifact is rejected before loading", async () => {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 512, sampleRate });
  expect(ctx.sampleRate).toBe(sampleRate);
  expect(defaultRate.worklet.bakedSampleRate).toBe(48_000);
  const addModule = vi.spyOn(ctx.audioWorklet, "addModule");
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await expect(createNode(ctx, defaultRate)).rejects.toThrow(
      /compiled for 48000 Hz.*runs at 44100 Hz/,
    );
    expect(addModule).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    addModule.mockRestore();
    fetch.mockRestore();
  }
});
