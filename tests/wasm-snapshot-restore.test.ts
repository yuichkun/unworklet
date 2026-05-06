// End-to-end snapshot/restore in the WASM offline pipeline. Verifies that
// (a) snapshot serializes the persistent state region, (b) a fresh
// instance with the same processor can restore it, and (c) the schemaHash
// gating rejects mismatched blobs.
import { describe, expect, test } from "vite-plus/test";
import { compileToWasm } from "@unworklet/compiler";
import {
  defineProcessor,
  audioOutput,
  state,
  buffer,
  forSample,
  add,
  mul,
} from "@unworklet/core";

const SR = 48000;

const processor = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const counter = state.f32(0, { name: "counter", snapshot: "persistent" });
  const lastBlock = buffer.f32({ size: 16, name: "lastBlock", snapshot: "persistent" });
  return {
    process: () => {
      forSample((i) => {
        const next = add(counter.load(), 1);
        counter.store(next);
        out.set(0, i, mul(next, 0.001));
        lastBlock.write(i, next);
      });
    },
  };
});

async function instantiate(p: any) {
  const r = compileToWasm(p, { sampleRate: SR });
  const mod = await WebAssembly.compile(r.binary as any);
  const inst = await WebAssembly.instantiate(mod, {
    math: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
    },
  });
  const e = inst.exports as any;
  e.init();
  return { e, layout: r.layout, mem: new Uint8Array(e.memory.buffer), schemaHash: r.graph.schemaHash };
}

// Build a UWSN-format snapshot blob from the running instance. Mirrors
// the worklet's _handleSnapshot logic.
function snapshotUWSN(inst: any, hash: string): Uint8Array {
  const stateBytes = inst.layout.stateRegion.size | 0;
  const persistentBufs = inst.layout.bufferRegion.buffers.filter((b: any) => b.snapshot === "persistent");
  const bufBytes = persistentBufs.reduce((s: number, b: any) => s + b.byteSize, 0);
  const headerSize = 4 + 4 + 4 + hash.length + 4 + 4;
  const total = headerSize + stateBytes + persistentBufs.length * 8 + bufBytes;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  out[p++] = 0x55; out[p++] = 0x57; out[p++] = 0x53; out[p++] = 0x4e;
  dv.setUint32(p, 1, true); p += 4;
  dv.setUint32(p, hash.length, true); p += 4;
  for (let i = 0; i < hash.length; i++) out[p + i] = hash.charCodeAt(i);
  p += hash.length;
  dv.setUint32(p, stateBytes, true); p += 4;
  out.set(inst.mem.subarray(inst.layout.stateRegion.offset, inst.layout.stateRegion.offset + stateBytes), p);
  p += stateBytes;
  dv.setUint32(p, persistentBufs.length, true); p += 4;
  for (const b of persistentBufs) {
    dv.setUint32(p, b.bufferId, true); p += 4;
    dv.setUint32(p, b.byteSize, true); p += 4;
    out.set(inst.mem.subarray(b.offset, b.offset + b.byteSize), p);
    p += b.byteSize;
  }
  return out.subarray(0, p);
}

// Restore that blob into a fresh instance (mirroring _handleRestore).
function restoreUWSN(inst: any, blob: Uint8Array, expectedHash: string): { restored: boolean; reason?: string } {
  if (blob[0] !== 0x55 || blob[1] !== 0x57 || blob[2] !== 0x53 || blob[3] !== 0x4e) {
    return { restored: false, reason: "bad-magic" };
  }
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let p = 4;
  const version = dv.getUint32(p, true); p += 4;
  if (version !== 1) return { restored: false, reason: "bad-version" };
  const hashLen = dv.getUint32(p, true); p += 4;
  let h = "";
  for (let i = 0; i < hashLen; i++) h += String.fromCharCode(blob[p + i]!);
  p += hashLen;
  if (h !== expectedHash) return { restored: false, reason: "schema-mismatch" };
  const stateBytes = dv.getUint32(p, true); p += 4;
  inst.mem.set(blob.subarray(p, p + stateBytes), inst.layout.stateRegion.offset);
  p += stateBytes;
  const nBufs = dv.getUint32(p, true); p += 4;
  for (let i = 0; i < nBufs; i++) {
    const bid = dv.getUint32(p, true); p += 4;
    const bsize = dv.getUint32(p, true); p += 4;
    const layout = inst.layout.bufferRegion.buffers.find((b: any) => b.bufferId === bid);
    if (!layout || layout.byteSize !== bsize) {
      p += bsize;
      continue;
    }
    inst.mem.set(blob.subarray(p, p + bsize), layout.offset);
    p += bsize;
  }
  return { restored: true };
}

describe("WASM snapshot/restore", () => {
  test("counter state survives a snapshot/restore roundtrip", async () => {
    const a = await instantiate(processor);
    // Run 8 blocks; counter should be at 8*128 = 1024.
    for (let i = 0; i < 8; i++) a.e.process(128);
    const blob = snapshotUWSN(a, a.schemaHash);

    const b = await instantiate(processor);
    const r = restoreUWSN(b, blob, b.schemaHash);
    expect(r.restored).toBe(true);

    // After restore the counter must be 1024. Run one block and check.
    b.e.process(128);
    const cOff = b.layout.stateRegion.slots.find((s: any) => s.type === "f32")!.offset;
    const counter = new Float32Array(b.e.memory.buffer)[cOff >> 2]!;
    expect(counter).toBe(1024 + 128);
  });

  test("schemaHash mismatch is rejected", async () => {
    const a = await instantiate(processor);
    a.e.process(128);
    // Tamper the hash so restore should refuse.
    const blob = snapshotUWSN(a, "DEADBEEF");
    const b = await instantiate(processor);
    const r = restoreUWSN(b, blob, b.schemaHash);
    expect(r.restored).toBe(false);
    expect(r.reason).toBe("schema-mismatch");
  });
});
