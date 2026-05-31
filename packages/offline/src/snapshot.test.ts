/**
 * Snapshot capture + restore + migration through `renderOffline` end-to-end
 * (`01-dsl.md` §8, `05-client.md` §2.6, `13-offline-render.md` §2.x). A render
 * captures the persistent slots into `result.state`; re-rendering with
 * `config.restore` seeds those slots; a schema-hash mismatch runs the
 * processor's migration chain first.
 */

import "@unworklet/core";
import {
  audioOutput,
  event,
  defineProcessor,
  encodeScalar,
  encodeSnapshot,
  f32,
  forSample,
  inspectSnapshot,
  state,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

// Counter that the per-block code increments; each sample outputs the current
// value, so block b outputs the value as of that block's start.
const counterProc = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const counter = state.i32(0).named("counter");
  return {
    process: () => {
      forSample((i) => {
        out.ch(0).at(i).write(f32(counter.read()));
      });
      counter.write(counter.read().add(1));
    },
  };
});

test("snapshot captures a persistent state slot at end-of-render", async () => {
  const r = await renderOffline(counterProc, { sampleRate: 48000, duration: 384 / 48000 });
  // 3 blocks: outputs 0,1,2; counter ends at 3.
  expect(r.outputs.main![0]![0]).toBe(0);
  expect(r.outputs.main![0]![128]).toBe(1);
  expect(r.outputs.main![0]![256]).toBe(2);
  expect(inspectSnapshot(r.state).slots.counter).toEqual({ kind: "state", type: "i32", value: 3 });
});

test("restore seeds the persistent state slot (carry-forward across renders)", async () => {
  const first = await renderOffline(counterProc, { sampleRate: 48000, duration: 384 / 48000 });
  // counter ended at 3 → a fresh render restored from it starts at 3.
  const second = await renderOffline(counterProc, {
    sampleRate: 48000,
    duration: 256 / 48000,
    restore: first.state,
  });
  expect(second.outputs.main![0]![0]).toBe(3); // carried, not 0
  expect(second.outputs.main![0]![128]).toBe(4);
  expect(inspectSnapshot(second.state).slots.counter).toEqual({
    kind: "state",
    type: "i32",
    value: 5,
  });
});

test("a persistent buffer round-trips through snapshot/restore", async () => {
  const wtProc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const wt = state.buffer.f32({ size: 8 }).expose({ name: "wt", snapshot: "persistent" });
    const upload = event<{ samples: Float32Array }>({ from: "main", name: "upload" });
    return {
      process: () => {
        upload.onReceive(({ samples }) => {
          wt.copyFrom(samples);
        });
        forSample((i) => {
          out.ch(0).at(i).write(wt.read(0));
        });
      },
    };
  });
  const first = await renderOffline(wtProc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    messages: [
      { name: "upload", payload: { samples: new Float32Array([0.5, 1, 2, 3]) }, atQuantum: 0 },
    ],
  });
  // wt[0] = 0.5 after upload (block 0 reads before upload drain? upload drains
  // first per Q38-b → wt[0] = 0.5 from sample 0).
  expect(first.outputs.main![0]![127]).toBeCloseTo(0.5, 5);
  expect(inspectSnapshot(first.state).slots.wt!.kind).toBe("buffer");
  // Restore into a fresh render with no upload → wt carried, still 0.5.
  const second = await renderOffline(wtProc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    restore: first.state,
  });
  expect(second.outputs.main![0]![0]).toBeCloseTo(0.5, 5);
});

test("restore runs the migration chain on a schema-hash mismatch", async () => {
  // The processor reads a `renamed`-named slot; an old blob stored it as `legacy`.
  const body = (): { process: () => void } => {
    const out = audioOutput({ channels: 1, name: "main" });
    const renamed = state.i32(0).named("renamed");
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(f32(renamed.read()));
        });
      },
    };
  };
  // The migration's `to` must equal the current schema hash; a probe build (same
  // graph, no migrations) yields it before the real processor is defined.
  const currentHash = defineProcessor(body).schemaHash;
  const migProc = defineProcessor(body, {
    migrations: [
      {
        from: "OLDHASH00000000",
        to: currentHash,
        migrate: (blob, h) => {
          const v = h.parseSlot(blob, "legacy", "i32");
          if (v !== undefined) h.writeSlot("renamed", "i32", v);
        },
      },
    ],
  });

  // An old-schema blob carrying the value under the legacy name.
  const oldBlob = encodeSnapshot("OLDHASH00000000", null, [
    { name: "legacy", kind: "state", type: "i32", data: encodeScalar("i32", 99) },
  ]);
  const r = await renderOffline(migProc, {
    sampleRate: 48000,
    duration: 128 / 48000,
    restore: oldBlob,
  });
  // The migration renamed legacy → renamed, so the processor reads 99.
  expect(r.outputs.main![0]![0]).toBe(99);
});
