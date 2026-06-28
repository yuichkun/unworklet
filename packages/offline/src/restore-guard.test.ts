/**
 * Regression: offline restore must reject (skip) a snapshot slot whose blob width
 * does not match the declared slot width — exactly as the worklet's applyRestoreSlots
 * does — instead of writing it raw and overrunning into the adjacent slot.
 *
 * Reachable when the schema changed (e.g. a state narrowed i64 → i32) and the
 * migration is missing: runMigrations passes the old-width blob through unchanged.
 */

import {
  audioOutput,
  compile,
  defineProcessor,
  encodeSnapshot,
  f32,
  forSample,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("offline restore skips a width-mismatched slot instead of overrunning the next slot", async () => {
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const x = state.i32(0).named("x"); // 4-byte slot
    const y = state.i32(42).named("y"); // 4-byte slot, packed right after x
    return {
      process: () => {
        // keep x live, then observe y in the output
        x.write(x.read());
        forSample((i) => {
          out.ch(0).at(i).write(f32(y.read()));
        });
      },
    };
  });
  const result = await compile(proc);
  // A mis-migrated blob: slot "x" carries 8 bytes (an i64 width) but x is i32 (4).
  // Writing it raw would overrun x and zero the adjacent y slot.
  const badBlob = encodeSnapshot(result.schemaHash, null, [
    { name: "x", kind: "state", type: "i64", data: new Uint8Array(8) },
  ]);
  const r = await renderOffline(proc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    restore: badBlob,
  });
  // The width-mismatched slot is skipped, so y keeps its declared default 42.
  expect(r.outputs.main![0]![0]).toBe(42);
});
