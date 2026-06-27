/**
 * Layer A (Tier-0) — the buffer-index clamp, verified behaviorally.
 *
 * A sound static in-bounds proof over arbitrary index expressions is not
 * tractable, so out-of-range buffer safety is enforced at the emitter (the index
 * is clamped into [0, length-1]) and proved here against a real offline render:
 * an out-of-range read/write must saturate to the boundary element and NEVER
 * trap (a single trap latches the processor to permanent silence) or read/write
 * an adjacent memory region.
 */

import { audioOutput, defineProcessor, forSample, state } from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("an out-of-range buffer index saturates to the boundary instead of trapping", async () => {
  // A literal OOB index is a compile-time error; the clamp guards a RUNTIME
  // index (a Node whose value is unknown at capture and can be out of range),
  // so the indices here come from state.
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const buf = state.buffer.f32({ size: 4 }).named("buf");
    const hi = state.i32(1000).named("hi"); // runtime OOB-high index
    const lo = state.i32(-5).named("lo"); // runtime OOB-low index
    return {
      process: () => {
        buf.write(hi.read(), 0.7); // runtime 1000 → clamps to the last element (3)
        buf.write(lo.read(), 0.3); // runtime -5   → clamps to the first element (0)
        forSample((i) => {
          // OOB-high read → buf[3] = 0.7; OOB-low read → buf[0] = 0.3; sum = 1.0.
          out
            .ch(0)
            .at(i)
            .write(buf.read(hi.read()).add(buf.read(lo.read())));
        });
      },
    };
  });

  // index 1000 pushes the byte address far past linear memory; without the clamp
  // the WASM traps and renderOffline rejects. It resolving + the exact saturated
  // value proves the clamp held for both the read and the write, high and low.
  const result = await renderOffline(proc, { sampleRate: 48000, duration: 64 / 48000 });
  expect(result.outputs.out![0]![10]).toBeCloseTo(1.0, 6);
  expect([...result.outputs.out![0]!].some(Number.isNaN)).toBe(false);
});
