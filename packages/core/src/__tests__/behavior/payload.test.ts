/**
 * typed-array message payload (Stage 2.5a) の compile-pipeline カバレッジ。
 *
 * end-to-end の振る舞い (= 受信した配列を at/length で読む) は driver が message
 * 注入を持たないため `@unworklet/offline` の renderOffline 黒箱テストで担保する。
 * ここは core 内で proxy (capture) + payloadContent layout + payloadField emit の
 * pipeline が compile を通り、layout に content region が確保されることを検証する。
 */

import { expect, test } from "vite-plus/test";

import "../../dsl/primitives.ts"; // side-effect: register `Node<T>` method forms
import { audioOutput, buffer, event, message, state } from "../../dsl/declarations.ts";
import { f32, i32 } from "../../dsl/constructors.ts";
import { forSample } from "../../dsl/loop.ts";
import { compile } from "../../compile/index.ts";
import { defineProcessor } from "../../processor.ts";

test("typed-array message compiles: proxy + payloadContent layout + payloadField emit", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const upload = message<{ samples: Float32Array }>({ name: "upload" });
    const buf = buffer.f32({ size: 8 });
    const lenState = state.named("len").i32(0);
    return {
      process: () => {
        upload.onReceive(({ samples }) => {
          lenState.store(samples.length); // payloadFieldLength
          forSample((i) => {
            buf.write(i, samples.at(i)); // payloadFieldRead (runtime indexed)
          });
        });
        forSample((i) => {
          out.ch(0).at(i).write(buf.read(i));
        });
      },
    };
  });

  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);

  // typed-array message には payloadContent region が割り当てられる。
  const memory = result.memory as unknown as {
    regions: { payloadContent: { slots: Record<string, { base: number; capacity: number }> } };
  };
  const content = memory.regions.payloadContent.slots["upload"];
  expect(content).toBeDefined();
  expect(content!.capacity).toBeGreaterThan(0);
});

test("typed-array message compiles: buf.copyFrom(payload) bulk-copy emit path", async () => {
  // end-to-end の振る舞い (= copy 結果の値一致 / clamp) は `@unworklet/offline` の
  // 黒箱テストで担保。ここは core 内で copyFrom proxy meta + bufferCopyFrom emit
  // (= memory.copy) が compile を通ることを検証する (= core coverage)。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const upload = message<{ samples: Float32Array }>({ name: "upload" });
    const buf = buffer.f32({ size: 8 });
    return {
      process: () => {
        upload.onReceive(({ samples }) => {
          buf.copyFrom(samples); // bufferCopyFrom (= memory.copy)
        });
        forSample((i) => {
          out.ch(0).at(i).write(buf.read(i));
        });
      },
    };
  });

  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  const memory = result.memory as unknown as {
    regions: { payloadContent: { slots: Record<string, { base: number; capacity: number }> } };
  };
  expect(memory.regions.payloadContent.slots["upload"]).toBeDefined();
});

test("typed-array event compiles: emitIf(buffer + length) emit path + payloadContent", async () => {
  // end-to-end の振る舞い (= 受信した配列の値一致) は `@unworklet/offline` の黒箱で担保。
  // ここは core 内で emitIf の buffer 検出 + event payloadContent layout + emitEventEmitIf
  // (= memory.copy) が compile を通り、event に content region が割り当たることを検証する。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = buffer.f32({ size: 4 });
    const result = event<{ data: Float32Array }>({ name: "result", payloadCapacity: 64 });
    return {
      process: () => {
        buf.write(0, f32(1));
        result.emitIf(true, { atSample: 0, data: buf, length: i32(4) });
        forSample((i) => {
          out.ch(0).at(i).write(f32(0));
        });
      },
    };
  });
  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  const memory = result.memory as unknown as {
    regions: { payloadContent: { slots: Record<string, { base: number; capacity: number }> } };
  };
  expect(memory.regions.payloadContent.slots["result"]).toBeDefined();
});

test("typed-array event emitIf requires a length field (= guard)", () => {
  expect(() =>
    defineProcessor(() => {
      const buf = buffer.f32({ size: 4 });
      const result = event<{ data: Float32Array }>({ name: "result", payloadCapacity: 64 });
      return {
        process: () => {
          // length ナシ = throw。
          (result as unknown as { emitIf(c: boolean, p: unknown): void }).emitIf(true, {
            atSample: 0,
            data: buf,
          });
        },
      };
    }),
  ).toThrow(/requires a "length" field/);
});

test("buf.copyFrom rejects a non-payload source (= 型外れ guard)", () => {
  expect(() =>
    defineProcessor(() => {
      const buf = buffer.f32({ size: 8 });
      return {
        process: () => {
          // payload field じゃない値を渡す = PAYLOAD_FIELD_META ナシ = throw。
          (buf as unknown as { copyFrom(x: unknown): void }).copyFrom({ length: 4 });
        },
      };
    }),
  ).toThrow(/typed-array message payload field/);
});
