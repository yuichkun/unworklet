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
  decodeSnapshot,
  encodeScalar,
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

for (const type of ["i32", "f64"] as const) {
  test(`offline restore skips f32 state and buffer bytes declared as ${type}`, async () => {
    const proc = defineProcessor(() => {
      state.named("scalar")[type](7);
      state.buffer[type]({ size: type === "i32" ? 2 : 1 }).expose({
        name: "samples",
        snapshot: "persistent",
      });
      return { process: () => {} };
    });
    const { schemaHash } = await compile(proc);
    const blob = encodeSnapshot(schemaHash, null, [
      {
        name: "scalar",
        kind: "state",
        type: "f32",
        data: new Uint8Array(new Float32Array([1]).buffer),
      },
      {
        name: "samples",
        kind: "buffer",
        type: "f32",
        data: new Uint8Array(new Float32Array([1, 2]).buffer),
      },
    ]);
    const result = await renderOffline(proc, { sampleRate: 48000, duration: 0, restore: blob });
    const decoded = decodeSnapshot(result.state);
    expect(decoded.slots.find((s) => s.name === "scalar")!.data).toEqual(encodeScalar(type, 7));
    expect(decoded.slots.find((s) => s.name === "samples")!.data).toEqual(new Uint8Array(8));
  });
}

test("offline restore accepts an explicit migration that converts a slot type", async () => {
  const body = () => {
    const value = state.named("value").i32(7);
    const out = audioOutput({ name: "main", channels: 1 });
    return { process: () => forSample((i) => out.ch(0).at(i).write(f32(value.read()))) };
  };
  const to = defineProcessor(body).schemaHash;
  const processor = defineProcessor(body, {
    migrations: [
      {
        from: "OLDHASH00000000",
        to,
        migrate: (blob, helpers) => {
          const value = helpers.parseSlot(blob, "value", "f32");
          if (value !== undefined) helpers.writeSlot("value", "i32", Math.round(value));
        },
      },
    ],
  });
  const restore = encodeSnapshot("OLDHASH00000000", null, [
    { name: "value", kind: "state", type: "f32", data: encodeScalar("f32", 3.5) },
  ]);
  const rendered = await renderOffline(processor, {
    sampleRate: 48000,
    duration: 128 / 48000,
    restore,
  });
  expect(Array.from(rendered.outputs.main![0]!)).toEqual(Array(128).fill(4));
});
