/**
 * End-user simulation (P6) — the RC-20 noise/distort source tested with
 * `@unworklet/test` against `renderOffline`. Behavioral assertions plus a
 * byte-exact audio snapshot. The same test must stay green after the processor
 * is rewritten in `.uwk.ts` (P5): the snapshot is the bit-exact regression
 * anchor that proves the rewrite compiles to identical audio.
 */
import { renderOffline } from "@unworklet/offline";
import { expectAudioMatchesSnapshot, expectStable } from "@unworklet/test";
import { expect, test } from "vite-plus/test";

// `?worklet` consumes the `.uwk.ts` exactly as an app does — the augmented default
// IS the CompiledProcessor renderOffline reads.
import noiseDrive from "./noise-drive.uwk.ts?worklet";

const SAMPLE_RATE = 48000;

test("noise-drive: 自走ノイズが安定して鳴り、決定的に再現する", async () => {
  const result = await renderOffline(noiseDrive, { sampleRate: SAMPLE_RATE, duration: 0.05 });
  expectStable(result); // NaN / 発散なし
  const ch = result.outputs["main"]![0]!;
  expect(ch.some((s) => s !== 0)).toBe(true); // 自走ジェネレータ = 無音ではない
  await expectAudioMatchesSnapshot(result); // byte-exact golden (= P5 の回帰アンカー)
});
