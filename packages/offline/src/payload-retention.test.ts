import "@unworklet/core";
import {
  bool,
  compile,
  decodeSnapshot,
  defineProcessor,
  event,
  f32,
  f64,
  forSample,
  i32,
  i64,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("declared payload storage above the WASM ceiling is rejected with a memory-budget diagnostic", async () => {
  const processor = defineProcessor(() => {
    const value = state.f32(0);
    const uploads = Array.from({ length: 5 }, (_, id) =>
      event<{ samples: Float32Array }>({
        from: "main",
        name: `upload${id}`,
        capacity: 16384,
      }),
    );
    return {
      process: () => {
        for (const upload of uploads) upload.onReceive(({ samples }) => value.write(samples.at(0)));
      },
    };
  });
  await expect(compile(processor)).rejects.toThrow(/\[memory-budget\].*4 GiB/s);
});

for (const [capacity, count] of [
  [32, 17],
  [512, 257],
  [32, 41],
] as const) {
  test(`inbound payloads retain their scalar metadata, length and contents (${count}/${capacity})`, async () => {
    const processor = defineProcessor(() => {
      const upload = event<{ id: number; samples: Float32Array }>({
        from: "main",
        name: "upload",
        capacity,
        payloadCapacity: 12,
      });
      const received = state.buffer
        .f32({ size: capacity * 5 })
        .expose({ name: "received", snapshot: "persistent" });
      const count = state.i32(0);
      return {
        process: () => {
          upload.onReceive(({ id, samples }) => {
            const offset = count.read().mul(5);
            received.write(offset, id);
            received.write(offset.add(1), f32(samples.length));
            for (let k = 0; k < 3; k++) received.write(offset.add(k + 2), samples.at(k));
            count.write(count.read().add(1));
          });
        },
      };
    });
    const values = Array.from({ length: count }, (_, n) => {
      const id = n + 1;
      return { id, samples: new Float32Array(Array.from({ length: id % 4 }, (_, k) => id + k)) };
    });
    const retained = values.slice(-capacity);
    const result = await renderOffline(processor, {
      sampleRate: 48000,
      duration: 128 / 48000,
      messages: values.map((payload) => ({ name: "upload", payload })),
    });
    const saved = decodeSnapshot(result.state).slots.find((slot) => slot.name === "received")!.data;
    expect(
      Array.from(new Float32Array(saved.buffer, saved.byteOffset, retained.length * 5)),
    ).toEqual(
      retained.flatMap(({ id, samples }) => [
        id,
        samples.length,
        ...Array.from({ length: 3 }, (_, k) => samples[Math.min(k, samples.length - 1)] ?? 0),
      ]),
    );
  });
}

for (const type of ["f32", "f64", "i32", "i64", "bool", "u8"] as const) {
  for (const capacity of [32, 512] as const) {
    test(`outbound ${type} payloads retain contents through ring capacity ${capacity}`, async () => {
      const processor = defineProcessor(() => {
        const samples = state.buffer[type]({ size: 3 });
        const wideId = state.i64(0n);
        const emitted = event<{ id: number; samples: typeof samples; length: number }>({
          to: "main",
          name: "upload",
          capacity,
          payloadCapacity: 24,
        });
        return {
          process: () =>
            forSample((i) => {
              for (let j = 0; j < 3; j++) {
                const id = i.mul(3).add(j);
                for (let k = 0; k < 3; k++) {
                  const value = id.mul(3).add(k);
                  if (type === "i64")
                    (samples as ReturnType<typeof state.buffer.i64>).write(
                      k,
                      wideId
                        .read()
                        .mul(i64(3n))
                        .add(i64(BigInt(k))),
                    );
                  else if (type === "f64")
                    (samples as ReturnType<typeof state.buffer.f64>).write(k, f64(value));
                  else if (type === "bool")
                    (samples as ReturnType<typeof state.buffer.bool>).write(
                      k,
                      bool(value.div(32).mod(2)),
                    );
                  else if (type === "f32")
                    (samples as ReturnType<typeof state.buffer.f32>).write(k, f32(value));
                  else (samples as ReturnType<typeof state.buffer.i32>).write(k, i32(value));
                }
                emitted.emitIf(id.lt(384), { id, samples, length: id.mod(4) });
                wideId.write(wideId.read().add(i64(1n)));
              }
            }),
        };
      });
      const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
      const first = Math.max(0, 384 - capacity);
      expect(result.events).toHaveLength(384 - first);
      for (let n = 0; n < result.events.length; n++) {
        const payload = result.events[n]!.payload as {
          id: number;
          samples: ArrayLike<number | bigint>;
        };
        const id = first + n;
        expect(payload.id).toBe(id);
        expect(Array.from(payload.samples)).toEqual(
          Array.from({ length: id % 4 }, (_, k) => {
            const value = id * 3 + k;
            return type === "i64"
              ? BigInt(value)
              : type === "bool"
                ? Math.floor(value / 32) % 2
                : type === "u8"
                  ? value & 255
                  : value;
          }),
        );
      }
    });
  }
}
