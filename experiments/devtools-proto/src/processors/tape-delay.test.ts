/**
 * End-user simulation (P6) — the RC-20 tape-echo tested with `@unworklet/test`.
 * An input impulse must come back as a wet echo `DELAY` samples later, and the
 * whole render must stay finite (the line has feedback). i64 `sampleCount`
 * exercises the integer-state path end-to-end. The byte-exact snapshot is the
 * regression anchor for the `.uwk.ts` rewrite (P5).
 */
import { renderOffline } from "@unworklet/offline";
import {
  expectAudioMatchesSnapshot,
  expectPeakAtSample,
  expectStable,
  impulse,
} from "@unworklet/test";
import { expect, test } from "vite-plus/test";

// `?worklet` consumes the `.uwk.ts` exactly as an app does — the augmented default
// IS the CompiledProcessor renderOffline reads.
import tapeDelay from "./tape-delay.uwk.ts?worklet";

const SAMPLE_RATE = 48000;
const DELAY = Math.round(SAMPLE_RATE * 0.3); // 14400 — processor と同じ tape-head spacing

test("tape-delay: 入力インパルスが DELAY サンプル後にエコーとして返る", async () => {
  const total = 19200; // 0.4s — DELAY(14400) を超える長さ、128 の倍数
  const result = await renderOffline(tapeDelay, {
    sampleRate: SAMPLE_RATE,
    duration: total / SAMPLE_RATE,
    inputs: { main: [impulse(total, { atSample: 0 })] },
  });
  expectStable(result); // feedback ループが発散しない
  expectPeakAtSample(result, 0); // dry のインパルスがサンプル0でピーク
  const ch = result.outputs["main"]![0]!;
  expect(Math.abs(ch[DELAY]!)).toBeGreaterThan(0.4); // DELAY 後に wet エコー (WET=0.5)
  await expectAudioMatchesSnapshot(result);
});
