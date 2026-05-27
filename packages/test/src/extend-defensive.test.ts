/**
 * `@unworklet/test/extend` chain form defensive 分 岐 用 test file。
 * `wrap()` / `toMatchAudioSnapshotChain` の catch 内 で `err instanceof Error`
 * が false に な る 経 路 (= plain 関 数 が non-Error を throw し た 場 合
 * の `String(err)` fallback) を `vi.mock` 経 由 で 強 制 hit。
 *
 * 通 常 plain 関 数 は `new Error(...)` の み を throw す る = 防 衛 的 分 岐、
 * mock で `throw "raw string"` を 起 こ し て String 変 換 path を 通 す。
 *
 * `vi.mock` は file 全 体 で hoist さ れ る た め こ の path 専 用 に file
 * 分 離。
 */

import { expect, test, vi } from "vite-plus/test";

vi.mock("./index.ts", async () => {
  const actual = await vi.importActual<typeof import("./index.ts")>("./index.ts");
  return {
    ...actual,
    // plain 関 数 を string throw に 置 換 = chain wrap catch 内 で
    // `err instanceof Error` を false に 落 と し て `String(err)` 分 岐 を hit。
    expectAudioMatches: () => {
      throw "raw-string-not-an-Error";
    },
    // chain `toMatchAudioSnapshot` 経 由 で 同 様 の non-Error throw を 起 こ し
    // て `toMatchAudioSnapshotChain` 末 尾 catch 内 の `String(err)` 分 岐 を hit。
    expectAudioMatchesSnapshotWithState: async () => {
      throw 42;
    },
  };
});

// 上 記 mock 適 用 後 に extend.ts を import (= mock 済 plain 関 数 を
// `expect.extend` の closure に 取 り 込 む)。
await import("./extend.ts");

import type { RenderOfflineResult } from "@unworklet/offline";

const monoResult = (channel: Float32Array): RenderOfflineResult => ({
  outputs: { main: [channel] },
  events: [],
  state: new Uint8Array(0),
  sampleRate: 48000,
});

test("`wrap()` catch 内 `String(err)` 分 岐 = plain が string throw し た 場 合 の fallback message", () => {
  // mock し た `expectAudioMatches` が `throw "raw-string-not-an-Error"` で
  // 非 Error を 投 げ る = `wrap()` catch 内 で `err instanceof Error` = false
  // = `String(err)` fallback path に 入 り 文 字 列 化 し た message が
  // vitest fail と し て 表 出。
  expect(() => expect(monoResult(new Float32Array(8))).toMatchAudio([new Float32Array(8)])).toThrow(
    /raw-string-not-an-Error/,
  );
});

test("`toMatchAudioSnapshotChain` catch 内 `String(err)` 分 岐 = number throw fallback", async () => {
  // mock し た `expectAudioMatchesSnapshotWithState` が `throw 42` で 非 Error
  // を 投 げ る = `toMatchAudioSnapshotChain` catch 内 で `err instanceof Error`
  // = false = `String(err)` (= "42") fallback path に 入 る。
  await expect(expect(monoResult(new Float32Array(8))).toMatchAudioSnapshot()).rejects.toThrow(
    /42/,
  );
});
