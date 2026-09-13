/**
 * Audio-output hygiene, end-to-end through real WASM (issue #27):
 *
 * 1. Non-finite samples (NaN / ±Inf from user DSP — 0/0, x/0, runaway
 *    accumulators) must never reach the output. Web Audio propagates them as
 *    silence/clicks across the downstream graph, so `audioOutWrite` scrubs
 *    them to 0 — and reports it: `renderOffline` exposes the count as
 *    `diagnostics.scrubbedSamples` (silently altering output would hide the
 *    author's bug).
 * 2. Buffer-backed feedback (the idiomatic delay line / comb) must flush
 *    subnormals on store like scalar state already does — a decaying denormal
 *    tail otherwise costs 10-100× CPU on the audio thread. Covers the scalar
 *    f32/f64 stores AND the SIMD `storeVec` lanes.
 * 3. SIMD `loadVec` / `storeVec` offsets saturate like their scalar
 *    counterparts — an out-of-range vector access must neither trap (which
 *    would latch permanent silence) nor touch adjacent regions.
 */

import { expect, test } from "vite-plus/test";

import { audioOutput, defineProcessor, f32, forSample, i32, select, state } from "@unworklet/core";
import { addVec, mulVec, splat, sumLanes, vec4 } from "@unworklet/core/simd";

import { renderOffline } from "./index.ts";

const RATE = 48000;

test("NaN from user DSP (0/0) is scrubbed to 0 and counted in diagnostics.scrubbedSamples", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const a = state.f32(0);
    const b = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(a.read().div(b.read())); // 0/0 = NaN every sample
        });
      },
    };
  });
  const r = await renderOffline(proc, { sampleRate: RATE, duration: 256 / RATE });
  const ch = r.outputs.main![0]!;
  expect(ch.length).toBe(256);
  expect(Array.from(ch).every((v) => v === 0)).toBe(true);
  expect(r.diagnostics.scrubbedSamples).toBe(256);
});

test("+Inf from user DSP (x/0) is scrubbed to 0 and counted", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const zero = state.f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(f32(1).div(zero.read())); // 1/0 = +Inf
        });
      },
    };
  });
  const r = await renderOffline(proc, { sampleRate: RATE, duration: 128 / RATE });
  const ch = r.outputs.main![0]!;
  expect(Array.from(ch).every((v) => v === 0)).toBe(true);
  expect(r.diagnostics.scrubbedSamples).toBe(128);
});

test("a clean processor reports zero scrubbed samples and its output is untouched", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(0.25);
        });
      },
    };
  });
  const r = await renderOffline(proc, { sampleRate: RATE, duration: 128 / RATE });
  expect(Array.from(r.outputs.main![0]!).every((v) => v === 0.25)).toBe(true);
  expect(r.diagnostics.scrubbedSamples).toBe(0);
});

test("f32 buffer feedback decay flushes subnormals to exactly 0 (delay-line denormal tail)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const dl = state.buffer.f32({ size: 4 });
    const seeded = state.bool(false);
    return {
      process: () => {
        forSample((i) => {
          // First sample seeds 1.0; every later sample halves through the
          // buffer store — the classic decaying feedback tail.
          dl.write(0, select(seeded.read(), dl.read(0).mul(0.5), 1));
          seeded.write(true);
          out.ch(0).at(i).write(dl.read(0));
        });
      },
    };
  });
  const r = await renderOffline(proc, { sampleRate: RATE, duration: 256 / RATE });
  const ch = r.outputs.main![0]!;
  expect(ch[0]).toBe(1);
  expect(ch[20]).toBeCloseTo(0.5 ** 20, 10);
  // 0.5^n dives under the 1e-30 flush threshold around n = 100. Without the
  // flush, sample 110 is ~7.7e-34 — representable, non-zero, and the start of
  // the denormal-tail CPU hazard. With it, the store snaps to exactly 0.
  expect(ch[110]).toBe(0);
  expect(ch[200]).toBe(0);
});

test("f64 buffer feedback decay flushes subnormals to exactly 0", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const dl = state.buffer.f64({ size: 4 });
    const seeded = state.bool(false);
    return {
      process: () => {
        forSample((i) => {
          dl.write(0, select(seeded.read(), dl.read(0).mul(0.5), 1));
          seeded.write(true);
          out
            .ch(0)
            .at(i)
            .write(f32(dl.read(0)));
        });
      },
    };
  });
  const r = await renderOffline(proc, { sampleRate: RATE, duration: 256 / RATE });
  const ch = r.outputs.main![0]!;
  expect(ch[0]).toBe(1);
  expect(ch[110]).toBe(0);
});

test("SIMD storeVec lanes flush subnormals to exactly 0 (vector delay-line decay)", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const dl = state.buffer.f32({ size: 4 });
    const seed = state.f32(1);
    return {
      process: () => {
        forSample((i) => {
          // One-shot injection of 1.0 into every lane (seed goes 1 → 0 after
          // the first sample), then a pure vector decay through storeVec.
          dl.storeVec(
            0,
            addVec(
              mulVec(dl.loadVec(0), splat(0.5)),
              vec4(seed.read(), seed.read(), seed.read(), seed.read()),
            ),
          );
          seed.write(0);
          out.ch(0).at(i).write(dl.read(3));
        });
      },
    };
  });
  const r = await renderOffline(proc, { sampleRate: RATE, duration: 256 / RATE });
  const ch = r.outputs.main![0]!;
  expect(ch[0]).toBe(1);
  expect(ch[20]).toBeCloseTo(0.5 ** 20, 10);
  expect(ch[110]).toBe(0);
});

test("SIMD storeVec with a computed offset flushes only subnormal lanes", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 4, name: "main" });
    const buf = state.buffer.f32({ size: 6 });
    const position = state.f32(0.25);
    const scale = state.f32(1e-15);
    return {
      process: () => {
        forSample((i) => {
          buf.storeVec(
            i32(sumLanes(splat(position.read()))),
            mulVec(vec4(1, -2, 1e-20, -1e-20), splat(sumLanes(splat(scale.read())).mul(0.25))),
          );
          out.ch(0).at(i).write(buf.read(1));
          out.ch(1).at(i).write(buf.read(2));
          out.ch(2).at(i).write(buf.read(3));
          out.ch(3).at(i).write(buf.read(4));
        });
      },
    };
  });
  const result = await renderOffline(proc, { sampleRate: RATE, duration: 256 / RATE });
  const channels = result.outputs.main!;
  for (let sample = 0; sample < 256; sample++) {
    expect(channels.map((channel) => channel[sample])).toEqual([
      Math.fround(1e-15),
      Math.fround(-2e-15),
      0,
      0,
    ]);
  }
  expect(result.diagnostics.scrubbedSamples).toBe(0);
});

test("SIMD loadVec/storeVec offsets saturate to the buffer bounds instead of trapping", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const buf = state.buffer.f32({ size: 8 });
    return {
      process: () => {
        forSample((i) => {
          // Runtime-computed offsets far outside the buffer, both directions.
          // Pre-fix these compute a raw address into (or past) neighboring
          // regions: a trap latches permanent silence; a near miss corrupts
          // another slot.
          buf.storeVec(i.add(10_000_000), splat(0.25)); // clamps to base index 4 → lanes 4..7
          buf.write(0, 2);
          const low = buf.loadVec(i.sub(1_000_000)); // clamps to base index 0 → lanes 0..3
          out
            .ch(0)
            .at(i)
            .write(sumLanes(low).add(buf.read(7)));
        });
      },
    };
  });
  const r = await renderOffline(proc, { sampleRate: RATE, duration: 128 / RATE });
  const ch = r.outputs.main![0]!;
  // lanes 0..3 = [2, 0, 0, 0] (only index 0 written) → sum 2; index 7 = 0.25.
  expect(ch[127]).toBeCloseTo(2.25, 6);
});
