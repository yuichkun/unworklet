// Snapshot-format bridge: convert an engine-format (UWS1) snapshot blob
// into the WASM-format (UWSN) blob that the WASM worklet's
// `_handleRestore` consumes.
//
// The two formats serve different purposes:
//   - UWS1 (engine) is path-keyed and self-describing; great for inspect
//     and migration walks because slot identity is by name.
//   - UWSN (wasm) is byte-offset packed; the WASM worklet writes it back
//     into linear memory verbatim.
//
// To migrate a stale UWS1 blob into a fresh WASM worklet, the host walks
// the migration chain via a JS Engine, then runs this helper to project
// the engine's current state into the WASM layout.

// We import lazily so this helper compiles even when @unworklet/core/internal
// isn't on the consumer's tree-shake path (e.g. if they only install
// @unworklet/worklet for the codegen helpers).
import type { CompiledProcessor } from "@unworklet/core";

export type WasmLayoutSummary = {
  schemaHash: string;
  stateRegion: {
    offset: number;
    size: number;
    slots: Array<{ slotId: number; path: string; type: string; offset: number; snapshot: any }>;
  };
  bufferRegion: {
    offset: number;
    size: number;
    buffers: Array<{ bufferId: number; path: string; type: string; offset: number; size: number; byteSize: number; snapshot: any }>;
  };
};

export async function engineSnapshotToWasm(
  processor: CompiledProcessor,
  uws1Blob: Uint8Array,
  layout: WasmLayoutSummary,
): Promise<Uint8Array | null> {
  const core = await import("@unworklet/core/internal");
  const eng = new (core as any).Engine(processor, { sampleRate: 48000, blockSize: 128 });
  const result = eng.restore(uws1Blob);
  if (!result || result.error) return null;
  const stateRegion = layout.stateRegion;
  const persistentBufs = layout.bufferRegion.buffers.filter((b) => b.snapshot === "persistent");
  const stateBytes = stateRegion.size | 0;
  const bufBytes = persistentBufs.reduce((s, b) => s + b.byteSize, 0);
  const hashStr = layout.schemaHash;
  const headerLen = 8 + 4 + hashStr.length + 4 + 4;
  const total = headerLen + stateBytes + persistentBufs.length * 8 + bufBytes;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  out[p++] = 0x55; out[p++] = 0x57; out[p++] = 0x53; out[p++] = 0x4e;
  dv.setUint32(p, 1, true); p += 4;
  dv.setUint32(p, hashStr.length, true); p += 4;
  for (let i = 0; i < hashStr.length; i++) out[p + i] = hashStr.charCodeAt(i);
  p += hashStr.length;
  dv.setUint32(p, stateBytes, true); p += 4;
  const stateView = new Uint8Array(out.buffer, p, stateBytes);
  for (const slot of stateRegion.slots) {
    if (slot.snapshot === "transient") continue;
    const sr = (eng.rt.allScopes ?? [])
      .flatMap((s: any) => s.states)
      .find((s: any) => s.slot.path === slot.path);
    if (!sr) continue;
    const dv2 = new DataView(stateView.buffer, stateView.byteOffset, stateView.byteLength);
    const off = slot.offset - stateRegion.offset;
    if (slot.type === "f32") dv2.setFloat32(off, sr.read() as number, true);
    else if (slot.type === "f64") dv2.setFloat64(off, sr.read() as number, true);
    else if (slot.type === "i32" || slot.type === "bool")
      dv2.setInt32(off, (sr.read() as number) | 0, true);
    else if (slot.type === "i64") dv2.setBigInt64(off, BigInt(sr.read() as number), true);
  }
  p += stateBytes;
  dv.setUint32(p, persistentBufs.length, true); p += 4;
  for (const b of persistentBufs) {
    dv.setUint32(p, b.bufferId, true); p += 4;
    dv.setUint32(p, b.byteSize, true); p += 4;
    const br = (eng.rt.allScopes ?? [])
      .flatMap((s: any) => s.buffers)
      .find((x: any) => x.slot.path === b.path);
    if (br) {
      const src = new Uint8Array(
        (br.storage as Float32Array | Int32Array).buffer,
        (br.storage as Float32Array | Int32Array).byteOffset,
        b.byteSize,
      );
      out.set(src, p);
    }
    p += b.byteSize;
  }
  return out.subarray(0, p);
}
