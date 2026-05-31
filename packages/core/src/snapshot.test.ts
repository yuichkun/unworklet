/**
 * Snapshot blob codec + migration engine (`01-dsl.md` §8, `05-client.md` §2.6).
 */

import { expect, test } from "vite-plus/test";

import { encodeScalar, type SnapshotSlot } from "./snapshot.ts";
import { decodeSnapshot, encodeSnapshot, inspectSnapshot, runMigrations } from "./snapshotBlob.ts";
import type { Migration } from "./types.ts";

test("encode → decode round-trips slots of every kind/type", () => {
  const slots: SnapshotSlot[] = [
    { name: "gain", kind: "param", type: "f32", data: encodeScalar("f32", 0.75) },
    { name: "phase", kind: "state", type: "f32", data: encodeScalar("f32", 1.5) },
    { name: "count", kind: "state", type: "i32", data: encodeScalar("i32", 42) },
    { name: "armed", kind: "state", type: "bool", data: encodeScalar("bool", true) },
    { name: "ticks", kind: "state", type: "i64", data: encodeScalar("i64", 2n ** 40n) },
    {
      name: "ir",
      kind: "buffer",
      type: "f32",
      data: new Uint8Array(new Float32Array([0.1, 0.2, 0.3]).buffer),
    },
  ];
  const blob = encodeSnapshot("abc123", "preset", slots);
  const decoded = decodeSnapshot(blob);
  expect(decoded.version).toBe(1);
  expect(decoded.schemaHash).toBe("abc123");
  expect(decoded.profile).toBe("preset");
  expect(decoded.slots.map((s) => s.name)).toEqual([
    "gain",
    "phase",
    "count",
    "armed",
    "ticks",
    "ir",
  ]);
});

test("null profile (union snapshot) round-trips", () => {
  const blob = encodeSnapshot("h", null, [
    { name: "x", kind: "state", type: "i32", data: encodeScalar("i32", 7) },
  ]);
  expect(decodeSnapshot(blob).profile).toBeNull();
});

test("decode rejects a non-snapshot byte array", () => {
  expect(() => decodeSnapshot(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/bad magic/);
});

test("decode throws a clear error on a truncated blob (not a raw RangeError / silent data)", () => {
  const full = encodeSnapshot("schema", null, [
    { name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.5) },
  ]);
  // Cut the slot's 4-byte payload short: the magic + header are intact, but the
  // declared dataLen now overruns the buffer. Without bounds checks this either
  // throws a raw DataView RangeError or silently returns a short `data` slice.
  const truncated = full.slice(0, full.length - 3);
  expect(() => decodeSnapshot(truncated)).toThrow(/corrupt or truncated/i);
});

test("decode throws a clear error when the header is cut mid-field", () => {
  const full = encodeSnapshot("schema", null, []);
  // 6 bytes = magic (4) + half of the version word → the next read overruns.
  expect(() => decodeSnapshot(full.slice(0, 6))).toThrow(/corrupt or truncated/i);
});

test("inspect decodes values per slot kind", () => {
  const blob = encodeSnapshot("schemaX", null, [
    { name: "gain", kind: "param", type: "f32", data: encodeScalar("f32", 0.5) },
    { name: "count", kind: "state", type: "i32", data: encodeScalar("i32", 9) },
    { name: "armed", kind: "state", type: "bool", data: encodeScalar("bool", true) },
    {
      name: "wave",
      kind: "buffer",
      type: "f32",
      data: new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer),
    },
  ]);
  const r = inspectSnapshot(blob);
  expect(r.schemaHash).toBe("schemaX");
  expect(r.slots.gain).toEqual({ kind: "param", value: 0.5 });
  expect(r.slots.count).toEqual({ kind: "state", type: "i32", value: 9 });
  expect(r.slots.armed).toEqual({ kind: "state", type: "bool", value: true });
  expect(r.slots.wave).toEqual({ kind: "buffer", type: "f32", length: 4, head: [1, 2, 3, 4] });
});

test("runMigrations: hash already current → no-op (applied empty)", () => {
  const blob = encodeSnapshot("current", null, [
    { name: "x", kind: "state", type: "i32", data: encodeScalar("i32", 1) },
  ]);
  const r = runMigrations(blob, [], "current");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.applied).toEqual([]);
    expect(r.blob).toBe(blob);
  }
});

test("runMigrations: renames a slot and auto-carries the rest", () => {
  const old = encodeSnapshot("aaaaaaaa", null, [
    { name: "lpfZ1", kind: "state", type: "f32", data: encodeScalar("f32", 0.3) },
    { name: "keep", kind: "state", type: "i32", data: encodeScalar("i32", 5) },
  ]);
  const migrations: Migration[] = [
    {
      from: "aaaaaaaa",
      to: "bbbbbbbb",
      migrate: (oldBlob, h) => {
        const v = h.parseSlot(oldBlob, "lpfZ1", "f32");
        if (v !== undefined) h.writeSlot("lpfPoleZ1", "f32", v);
      },
    },
  ];
  const r = runMigrations(old, migrations, "bbbbbbbb");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.applied).toEqual(["aaaaaaaa -> bbbbbbbb"]);
  const inspected = inspectSnapshot(r.blob);
  expect(inspected.slots.lpfPoleZ1).toEqual({
    kind: "state",
    type: "f32",
    value: expect.closeTo(0.3, 5),
  });
  expect(inspected.slots.keep).toEqual({ kind: "state", type: "i32", value: 5 }); // auto-carried
});

test("runMigrations: a throwing migrate yields ok:false with the failing step", () => {
  const old = encodeSnapshot("aaaaaaaa", null, []);
  const migrations: Migration[] = [
    {
      from: "aaaaaaaa",
      to: "bbbbbbbb",
      migrate: () => {
        throw new Error("hostile migration");
      },
    },
  ];
  const r = runMigrations(old, migrations, "bbbbbbbb");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.step).toBe("aaaaaaaa -> bbbbbbbb");
  expect(r.error.message).toBe("hostile migration");
});

test("runMigrations: an async migrate is rejected (migrations are sync-only)", () => {
  const old = encodeSnapshot("aaaaaaaa", null, []);
  const migrations: Migration[] = [
    {
      from: "aaaaaaaa",
      to: "bbbbbbbb",
      // `void` return is permissive in TS, so an async function type-checks; it
      // must still fail loud since the chain runs on the sync quantum boundary.
      migrate: async () => {},
    },
  ];
  const r = runMigrations(old, migrations, "bbbbbbbb");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.message).toMatch(/async migrate is not supported/i);
});

test("runMigrations: no path to the current hash → unchanged (caller falls back)", () => {
  const old = encodeSnapshot("zzzzzzzz", null, [
    { name: "x", kind: "state", type: "i32", data: encodeScalar("i32", 1) },
  ]);
  const r = runMigrations(old, [], "current");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.applied).toEqual([]);
});

test("runMigrations: walks a multi-step chain in order", () => {
  const old = encodeSnapshot("h0", null, [
    { name: "v", kind: "state", type: "i32", data: encodeScalar("i32", 1) },
  ]);
  const migrations: Migration[] = [
    {
      from: "h0",
      to: "h1",
      migrate: (b, h) => h.writeSlot("v", "i32", (h.parseSlot(b, "v", "i32") ?? 0) + 10),
    },
    {
      from: "h1",
      to: "h2",
      migrate: (b, h) => h.writeSlot("v", "i32", (h.parseSlot(b, "v", "i32") ?? 0) * 2),
    },
  ];
  const r = runMigrations(old, migrations, "h2");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.applied).toEqual(["h0 -> h1", "h1 -> h2"]);
  expect(inspectSnapshot(r.blob).slots.v).toEqual({ kind: "state", type: "i32", value: 22 }); // (1+10)*2
});
