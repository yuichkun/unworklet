import { expect, test } from "vite-plus/test";
import { decodeSnapshot, encodeSnapshot } from "../snapshotBlob.ts";
import {
  observeCrossRealm,
  corruptCrossRealmAutomation,
} from "./browser/fixtures/crossrealm-observation.ts";
import { renderCrossRealmOracle } from "./browser/fixtures/crossrealm-oracle.ts";

for (const sampleRate of [44_100, 48_000]) {
  test(`cross-realm oracle: exact stereo gain PCM at ${sampleRate} Hz`, async () => {
    const result = await renderCrossRealmOracle("stereo", sampleRate);
    const expected = [
      Float32Array.from({ length: 512 }, (_, i) => i / 2048),
      Float32Array.from({ length: 512 }, (_, i) => -(i + 1) / 4096),
    ];
    expect(result.pcm).toEqual(
      expected.map((channel) => Array.from(new Uint32Array(channel.buffer))),
    );
    expect(result.events).toEqual([]);
    expect(result.snapshot.slots).toEqual([
      { name: "gain", kind: "param", type: "f32", data: [0, 0, 0, 63] },
    ]);
  });

  test(`cross-realm oracle: sample-accurate gain steps at ${sampleRate} Hz`, async () => {
    const result = await renderCrossRealmOracle("automated-stereo", sampleRate);
    const expectedGain = (i: number) =>
      i < 64 ? 0.5 : i < 128 ? 0.25 : i < 255 ? 1 : i < 384 ? 0 : 2;
    const expected = [
      Float32Array.from({ length: 512 }, (_, i) => (i / 1024) * expectedGain(i)),
      Float32Array.from({ length: 512 }, (_, i) => (-(i + 1) / 2048) * expectedGain(i)),
    ];
    expect(result.pcm).toEqual(
      expected.map((channel) => Array.from(new Uint32Array(channel.buffer))),
    );
    expect(result.events).toEqual([]);
    expect(result.snapshot.slots).toEqual([
      { name: "gain", kind: "param", type: "f32", data: [0, 0, 0, 64] },
    ]);
    const raw = result.pcm.map((bits) => new Float32Array(Uint32Array.from(bits).buffer));
    const snapshot = encodeSnapshot(
      result.snapshot.schemaHash,
      result.snapshot.profile,
      result.snapshot.slots.map((slot) => ({ ...slot, data: Uint8Array.from(slot.data) })),
      result.snapshot.processorId,
    );
    for (const corrupted of corruptCrossRealmAutomation(raw))
      expect(observeCrossRealm(corrupted, result.events, snapshot)).not.toEqual(result);
  });

  test(`cross-realm oracle: stateful input, complete events and snapshot at ${sampleRate} Hz`, async () => {
    const result = await renderCrossRealmOracle("stateful", sampleRate);
    expect(result.pcm).toHaveLength(1);
    expect(result.pcm[0]).toEqual(
      Array.from(new Uint32Array(Float32Array.from({ length: 512 }, (_, i) => i / 2048).buffer)),
    );
    expect(result.events).toEqual(
      Array.from({ length: 4 }, (_, block) => ({
        name: "frame",
        atSample: 127,
        payload: {
          block: block + 1,
          level: (block * 128 + 127) / 1024,
          samples: Array.from({ length: 8 }, (_, i) => (block * 128 + i) / 1024),
        },
      })),
    );
    expect(result.snapshot).toMatchObject({
      version: 2,
      profile: null,
      processorId: "crossrealm-stateful",
    });
    expect(result.snapshot.schemaHash).toMatch(/^[0-9a-f]+$/);
    expect(result.snapshot.slots).toEqual([
      { name: "blocks", kind: "state", type: "i32", data: [4, 0, 0, 0] },
      {
        name: "history",
        kind: "buffer",
        type: "f32",
        data: Array.from(
          new Uint8Array(Float32Array.from({ length: 128 }, (_, i) => (384 + i) / 1024).buffer),
        ),
      },
      {
        name: "last",
        kind: "state",
        type: "f32",
        data: Array.from(new Uint8Array(new Float32Array([511 / 1024]).buffer)),
      },
    ]);
  });
}

test("cross-realm comparison rejects a one-bit PCM error, missing/reordered/timed events and late buffer corruption", async () => {
  const expected = await renderCrossRealmOracle("stateful", 48_000);
  const raw = {
    pcm: expected.pcm.map((bits) => new Float32Array(Uint32Array.from(bits).buffer)),
    events: structuredClone(expected.events),
    snapshot: decodeSnapshot(
      encodeSnapshot(
        expected.snapshot.schemaHash,
        expected.snapshot.profile,
        expected.snapshot.slots.map((slot) => ({ ...slot, data: Uint8Array.from(slot.data) })),
        expected.snapshot.processorId,
      ),
    ),
  };
  const observe = (value: typeof raw) =>
    observeCrossRealm(
      value.pcm,
      value.events,
      encodeSnapshot(
        value.snapshot.schemaHash,
        value.snapshot.profile,
        value.snapshot.slots,
        value.snapshot.processorId,
      ),
    );
  const mutations = [
    (r: typeof raw) => {
      new Uint32Array(r.pcm[0]!.buffer)[511]! ^= 1;
    },
    (r: typeof raw) => {
      r.events.pop();
    },
    (r: typeof raw) => {
      r.events.reverse();
    },
    (r: typeof raw) => {
      r.events[0]!.atSample++;
    },
    (r: typeof raw) => {
      (r.events[0]!.payload.samples as number[])[7]! += 1 / 1024;
    },
    (r: typeof raw) => {
      r.snapshot.slots.find((s) => s.name === "blocks")!.data[0]++;
    },
    (r: typeof raw) => {
      r.snapshot.slots.find((s) => s.name === "history")!.data[511]! ^= 1;
    },
  ];
  expect(observe(raw)).toEqual(expected);
  for (const mutate of mutations) {
    const actual = structuredClone(raw);
    mutate(actual);
    expect(() => expect(observe(actual)).toEqual(expected)).toThrow();
  }
});
