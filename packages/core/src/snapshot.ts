/**
 * Snapshot primitives shared by the worklet realm and the main thread
 * (`01-dsl.md` §8, `05-client.md` §2.6).
 *
 * WORKLET-SAFE: this module is reachable from `worklet-entry.ts`, so it must
 * stay free of main-thread / Node web APIs (`TextEncoder` / `TextDecoder` /
 * `fetch` / timers / DOM). The audio thread only deals with raw per-slot bytes
 * (scalar ↔ bytes, persistence policy); assembling / parsing the self-describing
 * blob (which UTF-8-encodes the schema hash + slot names) lives in the
 * main-only `./snapshotBlob.ts`. The `worklet-realm-files.ts` + `vite.config.ts`
 * lint guard forbids restricted globals here.
 */

import type { BufferElementType, ScalarType, TypedArrayOf } from "./types.ts";

/** Byte width of one scalar / buffer element by type (`01-dsl.md` §3 storage). */
export const SNAPSHOT_ELEMENT_BYTES: Record<string, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
  u8: 1,
};

/**
 * Whether a declaration participates in a snapshot under `profile` (`01-dsl.md`
 * §8.2). `defaultPolicy` is the per-kind default (`state` / `param` =
 * `'persistent'`, `buffer` = `'transient'`). A profile-map policy is persistent
 * for the named profile, or — when no profile is selected — if ANY profile marks
 * it persistent (so the no-profile snapshot is the union of every profile).
 */
export function isPersistent(
  policy: unknown,
  defaultPolicy: "persistent" | "transient",
  profile: string | undefined,
): boolean {
  const p = policy ?? defaultPolicy;
  if (p === "persistent") return true;
  if (p === "transient") return false;
  const record = p as Record<string, string>;
  if (profile !== undefined) return record[profile] === "persistent";
  return Object.values(record).some((v) => v === "persistent");
}

export type SnapshotSlotKind = "state" | "param" | "buffer";

/** One decoded slot: raw little-endian bytes tagged by kind + element type. */
export type SnapshotSlot = {
  name: string;
  kind: SnapshotSlotKind;
  type: BufferElementType;
  data: Uint8Array;
};

// ── scalar value ↔ bytes ──────────────────────────────────────────────────

export function encodeScalar(type: ScalarType, value: number | bigint | boolean): Uint8Array {
  const buf = new ArrayBuffer(type === "f64" || type === "i64" ? 8 : 4);
  const dv = new DataView(buf);
  switch (type) {
    case "f32":
      dv.setFloat32(0, Number(value), true);
      break;
    case "f64":
      dv.setFloat64(0, Number(value), true);
      break;
    case "i32":
      dv.setInt32(0, Number(value) | 0, true);
      break;
    case "i64":
      dv.setBigInt64(0, BigInt(value as bigint), true);
      break;
    case "bool":
      dv.setInt32(0, value ? 1 : 0, true);
      break;
  }
  return new Uint8Array(buf);
}

export function decodeScalar(type: ScalarType, data: Uint8Array): number | bigint | boolean {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (type) {
    case "f32":
      return dv.getFloat32(0, true);
    case "f64":
      return dv.getFloat64(0, true);
    case "i32":
      return dv.getInt32(0, true);
    case "i64":
      return dv.getBigInt64(0, true);
    case "bool":
      return dv.getInt32(0, true) !== 0;
  }
}

const TYPED_ARRAY_CTOR = {
  f32: Float32Array,
  f64: Float64Array,
  i32: Int32Array,
  i64: BigInt64Array,
  bool: Uint8Array,
  u8: Uint8Array,
} as const;

export function decodeTypedArray<T extends BufferElementType>(
  type: T,
  data: Uint8Array,
): TypedArrayOf<T> {
  const Ctor = TYPED_ARRAY_CTOR[type];
  // copy to a fresh aligned buffer (= blob bytes may be unaligned subarray).
  const copy = data.slice();
  return new Ctor(copy.buffer) as unknown as TypedArrayOf<T>;
}
