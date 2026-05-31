/**
 * Snapshot blob codec + migration engine (`01-dsl.md` §8, `05-client.md` §2.6).
 *
 * The blob is a self-describing `Uint8Array`: a version + the schema hash it was
 * minted under + an optional profile name + the `'persistent'` slot values
 * (state scalars, buffer arrays, param current values). `inspect` decodes it for
 * tooling; `runMigrations` walks a `from → to` migration chain to bridge an old
 * blob to the current schema; both are pure (no `AudioContext`, no live memory).
 *
 * Layout (all integers little-endian):
 *   magic 'UWK1' (4) | version:u32 | hashLen:u32 | hash:utf8
 *   | profileFlag:u8 | profileLen:u32 | profile:utf8 | slotCount:u32
 *   per slot: nameLen:u32 | name:utf8 | kind:u8 | type:u8 | dataLen:u32 | data
 */

import type {
  BufferElementType,
  InspectionResult,
  Migration,
  MigrationHelpers,
  ScalarOf,
  ScalarType,
  SlotInspection,
  TypedArrayOf,
} from "./types.ts";

export const SNAPSHOT_VERSION = 1;
const MAGIC = 0x55574b31; // 'UWK1'

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

export type DecodedSnapshot = {
  version: number;
  schemaHash: string;
  profile: string | null;
  slots: SnapshotSlot[];
};

const KIND_CODE: Record<SnapshotSlotKind, number> = { state: 0, param: 1, buffer: 2 };
const KIND_BY_CODE: SnapshotSlotKind[] = ["state", "param", "buffer"];
const TYPE_CODE: Record<BufferElementType, number> = {
  f32: 0,
  f64: 1,
  i32: 2,
  i64: 3,
  bool: 4,
  u8: 5,
};
const TYPE_BY_CODE: BufferElementType[] = ["f32", "f64", "i32", "i64", "bool", "u8"];

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export function encodeSnapshot(
  schemaHash: string,
  profile: string | null,
  slots: readonly SnapshotSlot[],
): Uint8Array {
  const hashBytes = utf8.encode(schemaHash);
  const profileBytes = profile === null ? new Uint8Array(0) : utf8.encode(profile);
  const slotChunks = slots.map((s) => {
    const nameBytes = utf8.encode(s.name);
    return { s, nameBytes };
  });
  let total = 4 + 4 + 4 + hashBytes.length + 1 + 4 + profileBytes.length + 4;
  for (const { s, nameBytes } of slotChunks) {
    total += 4 + nameBytes.length + 1 + 1 + 4 + s.data.length;
  }
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let p = 0;
  dv.setUint32(p, MAGIC, true);
  p += 4;
  dv.setUint32(p, SNAPSHOT_VERSION, true);
  p += 4;
  dv.setUint32(p, hashBytes.length, true);
  p += 4;
  bytes.set(hashBytes, p);
  p += hashBytes.length;
  dv.setUint8(p, profile === null ? 0 : 1);
  p += 1;
  dv.setUint32(p, profileBytes.length, true);
  p += 4;
  bytes.set(profileBytes, p);
  p += profileBytes.length;
  dv.setUint32(p, slots.length, true);
  p += 4;
  for (const { s, nameBytes } of slotChunks) {
    dv.setUint32(p, nameBytes.length, true);
    p += 4;
    bytes.set(nameBytes, p);
    p += nameBytes.length;
    dv.setUint8(p, KIND_CODE[s.kind]);
    p += 1;
    dv.setUint8(p, TYPE_CODE[s.type]);
    p += 1;
    dv.setUint32(p, s.data.length, true);
    p += 4;
    bytes.set(s.data, p);
    p += s.data.length;
  }
  return bytes;
}

export function decodeSnapshot(blob: Uint8Array): DecodedSnapshot {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let p = 0;
  // Bounds guard: a corrupt / truncated blob must fail loud with a clear error
  // rather than a raw DataView RangeError or a silently-short subarray / slice
  // (= a declared length overrunning the buffer reads garbage / zero-pads).
  const need = (n: number): void => {
    if (n < 0 || p + n > blob.byteLength) {
      throw new Error(
        `unworklet: corrupt or truncated snapshot blob (need ${n} bytes at offset ${p}, ` +
          `have ${blob.byteLength}). (stable ID 'snapshot-decode-bounds')`,
      );
    }
  };
  need(4);
  if (dv.getUint32(p, true) !== MAGIC) {
    throw new Error("unworklet: not a valid snapshot blob (bad magic)");
  }
  p += 4;
  need(4);
  const version = dv.getUint32(p, true);
  p += 4;
  need(4);
  const hashLen = dv.getUint32(p, true);
  p += 4;
  need(hashLen);
  const schemaHash = utf8d.decode(blob.subarray(p, p + hashLen));
  p += hashLen;
  need(1);
  const hasProfile = dv.getUint8(p) === 1;
  p += 1;
  need(4);
  const profileLen = dv.getUint32(p, true);
  p += 4;
  need(profileLen);
  const profile = hasProfile ? utf8d.decode(blob.subarray(p, p + profileLen)) : null;
  p += profileLen;
  need(4);
  const slotCount = dv.getUint32(p, true);
  p += 4;
  const slots: SnapshotSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    need(4);
    const nameLen = dv.getUint32(p, true);
    p += 4;
    need(nameLen);
    const name = utf8d.decode(blob.subarray(p, p + nameLen));
    p += nameLen;
    need(1);
    const kind = KIND_BY_CODE[dv.getUint8(p)]!;
    p += 1;
    need(1);
    const type = TYPE_BY_CODE[dv.getUint8(p)]!;
    p += 1;
    need(4);
    const dataLen = dv.getUint32(p, true);
    p += 4;
    need(dataLen);
    slots.push({ name, kind, type, data: blob.slice(p, p + dataLen) });
    p += dataLen;
  }
  return { version, schemaHash, profile, slots };
}

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

// ── inspect ─────────────────────────────────────────────────────────────────

export function inspectSnapshot(blob: Uint8Array): InspectionResult {
  const decoded = decodeSnapshot(blob);
  const slots: Record<string, SlotInspection> = {};
  for (const s of decoded.slots) {
    if (s.kind === "param") {
      slots[s.name] = { kind: "param", value: Number(decodeScalar("f32", s.data)) };
    } else if (s.kind === "state") {
      slots[s.name] = {
        kind: "state",
        type: s.type as ScalarType,
        value: decodeScalar(s.type as ScalarType, s.data) as number | boolean,
      };
    } else {
      const arr = decodeTypedArray(s.type, s.data);
      const head: number[] = [];
      const previewLen = Math.min(arr.length, 64);
      for (let i = 0; i < previewLen; i++) head.push(Number(arr[i]));
      slots[s.name] = { kind: "buffer", type: s.type, length: arr.length, head };
    }
  }
  return {
    version: decoded.version,
    schemaHash: decoded.schemaHash,
    profile: decoded.profile,
    slots,
  };
}

// ── migration engine ─────────────────────────────────────────────────────────

/** A migration step's `from -> to` label (hashes truncated for readability). */
function stepLabel(from: string, to: string): string {
  return `${from.slice(0, 8)} -> ${to.slice(0, 8)}`;
}

/**
 * Build the `MigrationHelpers` for one migrate step: reads come from the input
 * blob's decoded slots; writes accumulate into `out` (the new-schema blob being
 * built). Slots not explicitly written are auto-carried by name (`01-dsl.md`
 * §8.3.1) by the caller after `migrate` runs.
 */
function makeHelpers(
  input: DecodedSnapshot,
  out: Map<string, SnapshotSlot>,
  written: Set<string>,
): MigrationHelpers {
  const find = (name: string, kind: SnapshotSlotKind): SnapshotSlot | undefined =>
    input.slots.find((s) => s.name === name && s.kind === kind);
  return {
    parseSlot: <T extends ScalarType>(_blob: Uint8Array, name: string, type: T) => {
      const slot = find(name, "state");
      return slot ? (decodeScalar(type, slot.data) as ScalarOf<T>) : undefined;
    },
    parseBuffer: <T extends BufferElementType>(_blob: Uint8Array, name: string, type: T) => {
      const slot = find(name, "buffer");
      return slot ? decodeTypedArray(type, slot.data) : undefined;
    },
    parseParam: (_blob: Uint8Array, name: string) => {
      const slot = find(name, "param");
      return slot ? Number(decodeScalar("f32", slot.data)) : undefined;
    },
    parseSlotInProfile: <T extends ScalarType>(
      _blob: Uint8Array,
      name: string,
      type: T,
      profile: string,
    ) => {
      // v1.0.0 blobs carry a single profile (or null = union): a profile-scoped
      // read sees the slot when the blob is that profile or a union.
      if (input.profile !== null && input.profile !== profile) return undefined;
      const slot = find(name, "state");
      return slot ? (decodeScalar(type, slot.data) as ScalarOf<T>) : undefined;
    },
    writeSlot: <T extends ScalarType>(name: string, type: T, value: ScalarOf<T>) => {
      out.set(name, { name, kind: "state", type, data: encodeScalar(type, value) });
      written.add(name);
    },
    writeBuffer: <T extends BufferElementType>(name: string, type: T, data: TypedArrayOf<T>) => {
      const bytes = new Uint8Array(
        (data as { buffer: ArrayBufferLike }).buffer,
        (data as { byteOffset: number }).byteOffset,
        (data as { byteLength: number }).byteLength,
      );
      out.set(name, { name, kind: "buffer", type, data: bytes.slice() });
      written.add(name);
    },
    writeParam: (name: string, value: number) => {
      out.set(name, { name, kind: "param", type: "f32", data: encodeScalar("f32", value) });
      written.add(name);
    },
    writeSlotInProfile: <T extends ScalarType>(
      name: string,
      type: T,
      value: ScalarOf<T>,
      _profile: string,
    ) => {
      out.set(name, { name, kind: "state", type, data: encodeScalar(type, value) });
      written.add(name);
    },
    oldSchemaHash: input.schemaHash,
    oldProfileName: input.profile,
  };
}

export type MigrationOutcome =
  | { ok: true; blob: Uint8Array; applied: string[] }
  | { ok: false; applied: string[]; error: { step: string; message: string; cause: unknown } };

/**
 * Bridge `blob` to `currentHash` via the `migrations` chain (`01-dsl.md`
 * §8.3.3). Returns the migrated blob + applied step labels, or a failure when a
 * `migrate` function throws (the chain stops; the caller restores defaults for
 * unmigrated slots). Returns the input unchanged when the hash already matches
 * or no path exists (the caller falls back to name-match partial restore).
 */
export function runMigrations(
  blob: Uint8Array,
  migrations: readonly Migration[],
  currentHash: string,
): MigrationOutcome {
  const decoded = decodeSnapshot(blob);
  if (decoded.schemaHash === currentHash) {
    return { ok: true, blob, applied: [] };
  }
  // Find a path from the blob's hash to the current hash through the chain.
  const byFrom = new Map<string, Migration>();
  for (const m of migrations) byFrom.set(m.from, m);
  const path: Migration[] = [];
  let cursor = decoded.schemaHash;
  const seen = new Set<string>();
  while (cursor !== currentHash) {
    const step = byFrom.get(cursor);
    if (step === undefined || seen.has(cursor)) {
      // No path — caller falls back to name-match partial restore.
      return { ok: true, blob, applied: [] };
    }
    seen.add(cursor);
    path.push(step);
    cursor = step.to;
  }
  // Apply each step: build the new-schema blob, auto-carry untouched slots.
  let current = decoded;
  const applied: string[] = [];
  for (const step of path) {
    const out = new Map<string, SnapshotSlot>();
    const written = new Set<string>();
    const helpers = makeHelpers(current, out, written);
    try {
      // `migrate` is declared sync (= returns void), but `void` is permissive in
      // TS so an accidental async function still reaches here as a Promise; read
      // the result as `unknown` to detect + reject it at runtime.
      const r: unknown = step.migrate(
        encodeSnapshot(current.schemaHash, current.profile, current.slots),
        helpers,
      );
      if (r instanceof Promise) {
        // Migrations run sync on both the worklet render-quantum boundary (no
        // await possible) and the offline renderer, so an async migrate cannot be
        // honored consistently. Fail loud, and swallow the abandoned promise so it
        // can't surface later as an unhandled rejection.
        r.catch(() => {});
        throw new Error(
          "unworklet: async migrate is not supported — migrations must be synchronous " +
            "(they run on the audio render-quantum boundary, which cannot await). " +
            "(stable ID 'async-migrate-unsupported')",
        );
      }
    } catch (cause) {
      return {
        ok: false,
        applied,
        error: { step: stepLabel(step.from, step.to), message: errorMessage(cause), cause },
      };
    }
    // Auto-carry: slots present in the input but not written keep their value.
    for (const s of current.slots) {
      if (!written.has(s.name)) out.set(s.name, s);
    }
    current = {
      version: SNAPSHOT_VERSION,
      schemaHash: step.to,
      profile: current.profile,
      slots: [...out.values()],
    };
    applied.push(stepLabel(step.from, step.to));
  }
  return {
    ok: true,
    blob: encodeSnapshot(current.schemaHash, current.profile, current.slots),
    applied,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
