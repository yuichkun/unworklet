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
import { audioOutput, event, message, state } from "../../dsl/declarations.ts";
import { f32, i32 } from "../../dsl/constructors.ts";
import { forSample } from "../../dsl/loop.ts";
import { compile } from "../../compile/index.ts";
import { defineProcessor } from "../../processor.ts";

test("typed-array message compiles: proxy + payloadContent layout + payloadField emit", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const upload = message<{ samples: Float32Array }>({ name: "upload" });
    const buf = state.buffer.f32({ size: 8 });
    const lenState = state.named("len").i32(0);
    return {
      process: () => {
        upload.onReceive(({ samples }) => {
          lenState.write(samples.length); // payloadFieldLength
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
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number; capacity: number }>;
        messageSlots: Record<string, { base: number; capacity: number }>;
      };
    };
  };
  const content = memory.regions.payloadContent.messageSlots["upload"];
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
    const buf = state.buffer.f32({ size: 8 });
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
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number; capacity: number }>;
        messageSlots: Record<string, { base: number; capacity: number }>;
      };
    };
  };
  expect(memory.regions.payloadContent.messageSlots["upload"]).toBeDefined();
});

test("typed-array event compiles: emitIf(buffer + length) emit path + payloadContent", async () => {
  // end-to-end の振る舞い (= 受信した配列の値一致) は `@unworklet/offline` の黒箱で担保。
  // ここは core 内で emitIf の buffer 検出 + event payloadContent layout + emitEventEmitIf
  // (= memory.copy) が compile を通り、event に content region が割り当たることを検証する。
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = state.buffer.f32({ size: 4 });
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
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number; capacity: number }>;
        messageSlots: Record<string, { base: number; capacity: number }>;
      };
    };
  };
  expect(memory.regions.payloadContent.eventSlots["result"]).toBeDefined();
});

test("typed-array event emitIf requires a length field (= guard)", () => {
  expect(() =>
    defineProcessor(() => {
      const buf = state.buffer.f32({ size: 4 });
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
      const buf = state.buffer.f32({ size: 8 });
      return {
        process: () => {
          // payload field じゃない値を渡す = PAYLOAD_FIELD_META ナシ = throw。
          (buf as unknown as { copyFrom(x: unknown): void }).copyFrom({ length: 4 });
        },
      };
    }),
  ).toThrow(/typed-array message payload field/);
});

// 同名の message<T> と event<T> は独立した名前空間 (= 同名 OK)。typed-array の content
// region は kind 別に分離され、同名でも別 region になる (= 名前だけ key にすると alias して
// silent cross-channel corruption する bug の回帰防止)。layout 不変条件なので compile-coverage
// で検証する (= end-to-end の各 channel 値は offline 黒箱で別途担保)。
test("同名の message と event は別の content region を持つ (= 名前空間 kind 別、alias 防止)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const inMsg = message<{ x: Float32Array }>({ name: "dup" }); // main → worklet
    const outEvt = event<{ x: Float32Array }>({ name: "dup", payloadCapacity: 64 }); // worklet → main
    const buf = state.buffer.f32({ size: 4 });
    return {
      process: () => {
        inMsg.onReceive(({ x }) => {
          buf.write(0, x.at(0)); // message typed-array field を使う (= payloadElementType seal)
        });
        buf.write(1, f32(99));
        outEvt.emitIf(true, { atSample: 0, x: buf, length: i32(1) }); // event typed-array field を使う
        forSample((i) => {
          out.ch(0).at(i).write(buf.read(0));
        });
      },
    };
  });
  const result = await compile(proc);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  const memory = result.memory as unknown as {
    regions: {
      payloadContent: {
        eventSlots: Record<string, { base: number }>;
        messageSlots: Record<string, { base: number }>;
      };
    };
  };
  const ev = memory.regions.payloadContent.eventSlots["dup"];
  const ms = memory.regions.payloadContent.messageSlots["dup"];
  expect(ev).toBeDefined();
  expect(ms).toBeDefined();
  // 同名でも event と message は別 region = 片方の content がもう片方を壊さない。
  expect(ev!.base).not.toBe(ms!.base);
});

// §5.1: payload (T) は variable-length (typed-array) field を 1 つまで。複数あると
// slot は単一の [payloadLen, payloadOffset] しか持てず transport が破綻するので
// graph-capture-time error。message 受信側 (a.at()/b.at() の両 seal) で検証。
test("payload に複数 typed-array field があると compile で reject する (§5.1 single-field limit)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const msg = message<{ a: Float32Array; b: Float32Array }>({ name: "two" });
    const buf = state.buffer.f32({ size: 4 });
    return {
      process: () => {
        msg.onReceive(({ a, b }) => {
          buf.write(0, a.at(0)); // a を typed-array field として seal
          buf.write(1, b.at(0)); // b も seal = 2 個目 = NG
        });
        forSample((i) => out.ch(0).at(i).write(buf.read(0)));
      },
    };
  });
  await expect(compile(proc)).rejects.toThrow(/multiple-typed-array-fields/);
});

// Q71: event<T> の全 emit site は field set が一致する必要がある。scalar field は
// checkSealedEventField が非 first emit を検証するが、typed-array field も同様に
// first site で seal されてない field を後続 site が足したら reject されるべき
// (= さもないと extra array field が silently 無視され Q71 field-set error にならない)。
test("event emit: 後続 site が first で未 seal の typed-array field を足すと reject (Q71)", () => {
  expect(() =>
    defineProcessor(() => {
      const out = audioOutput({ channels: 1, name: "main" });
      const buf = state.buffer.f32({ size: 4 });
      const evt = event<{ a: number }>({ name: "evt", payloadCapacity: 64 });
      return {
        process: () => {
          evt.emitIf(true, { atSample: 0, a: i32(1) }); // first site = [a] を seal
          // 後続 site が未 seal の typed-array "x" を追加 (型外 = cast) = Q71 field-set 違反
          (evt as unknown as { emitIf(c: boolean, p: Record<string, unknown>): void }).emitIf(
            true,
            {
              atSample: 0,
              a: i32(1),
              x: buf,
              length: i32(4),
            },
          );
          forSample((i) => out.ch(0).at(i).write(f32(0)));
        },
      };
    }),
  ).toThrow(/typed-array field|field set/i);
});
