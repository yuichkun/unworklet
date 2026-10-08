import { expect, test } from "vite-plus/test";
import { renderCrossRealmOracle } from "./browser/fixtures/crossrealm-oracle.ts";

for (const sampleRate of [44_100, 48_000]) {
  test(`native-rate oracle: every PCM bit, block-local event and persistent byte at ${sampleRate} Hz`, async () => {
    const result = await renderCrossRealmOracle("native-rate", sampleRate);
    const value = (n: number) => Math.fround(n * Math.fround(1 / sampleRate));
    const pcm = Float32Array.from({ length: 512 }, (_, i) => value(i + 1));
    expect(result.pcm).toEqual([Array.from(new Uint32Array(pcm.buffer))]);
    expect(result.events).toEqual(
      Array.from({ length: 4 }, (_, i) => ({
        name: "frame",
        atSample: 127,
        payload: { block: i + 1, level: value((i + 1) * 128) },
      })),
    );
    expect(result.snapshot).toMatchObject({
      version: 2,
      profile: null,
      processorId: "native-rate",
    });
    expect(result.snapshot.slots).toEqual([
      { name: "blocks", kind: "state", type: "i32", data: [4, 0, 0, 0] },
      { name: "counter", kind: "state", type: "i32", data: [0, 2, 0, 0] },
      {
        name: "last",
        kind: "state",
        type: "f32",
        data: Array.from(new Uint8Array(new Float32Array([value(512)]).buffer)),
      },
    ]);
  });
}

test("native-rate oracle rejects independently calculated 48000-rate PCM at 44100", async () => {
  const result = await renderCrossRealmOracle("native-rate", 44_100);
  const wrong = Float32Array.from({ length: 512 }, (_, i) =>
    Math.fround((i + 1) * Math.fround(1 / 48_000)),
  );
  expect(result.pcm[0]).not.toEqual(Array.from(new Uint32Array(wrong.buffer)));
});
