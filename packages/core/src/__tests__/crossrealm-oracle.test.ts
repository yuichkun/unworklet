import { expect, test } from "vite-plus/test";
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
    expect(result.snapshot.slots.find((s) => s.name === "blocks")?.data).toEqual([4, 0, 0, 0]);
    expect(result.snapshot.slots.find((s) => s.name === "history")?.data).toEqual(
      Array.from(
        new Uint8Array(Float32Array.from({ length: 128 }, (_, i) => (384 + i) / 1024).buffer),
      ),
    );
  });
}

test("cross-realm comparison rejects a one-bit PCM error, missing/reordered/timed events and late buffer corruption", async () => {
  const expected = await renderCrossRealmOracle("stateful", 48_000);
  const mutations = [
    (r: typeof expected) => {
      r.pcm[0]![511]! ^= 1;
    },
    (r: typeof expected) => {
      r.events.pop();
    },
    (r: typeof expected) => {
      r.events.reverse();
    },
    (r: typeof expected) => {
      r.events[0]!.atSample++;
    },
    (r: typeof expected) => {
      (r.events[0]!.payload.samples as number[])[7]! += 1 / 1024;
    },
    (r: typeof expected) => {
      r.snapshot.slots.find((s) => s.name === "blocks")!.data[0]++;
    },
    (r: typeof expected) => {
      r.snapshot.slots.find((s) => s.name === "history")!.data[511]! ^= 1;
    },
  ];
  for (const mutate of mutations) {
    const actual = structuredClone(expected);
    mutate(actual);
    expect(() => expect(actual).toEqual(expected)).toThrow();
  }
  expect(structuredClone(expected)).toEqual(expected);
});
