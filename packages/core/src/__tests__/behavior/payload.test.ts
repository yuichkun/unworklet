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
import { audioOutput, buffer, message, state } from "../../dsl/declarations.ts";
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
