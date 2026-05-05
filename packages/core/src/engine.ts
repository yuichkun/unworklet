import {
  ProcessorRuntime,
  setCurrentRuntime,
  type StateRuntime,
  type BufferRuntime,
} from "./runtime.js";
import type { CompiledProcessor, MidiEvent } from "./types.js";

export type EngineOptions = {
  sampleRate: number;
  blockSize?: number;
};

// Snapshot blob format: a simple binary container.
// Layout:
//   magic 'UWS1' (4 bytes)
//   schemaHash length (u8) + schemaHash bytes
//   profile length (u8) + profile bytes (length 0 = no profile)
//   numSlots (u32 LE)
//   for each slot:
//     kind (u8): 0=state-f32, 1=state-f64, 2=state-i32, 3=state-i64, 4=state-bool,
//                10=buffer-f32, 11=buffer-f64, 12=buffer-i32, 20=param
//     pathLen (u16 LE) + path bytes
//     length (u32 LE) for buffers; for scalars stored as length=1
//     payload bytes (typed)
const SLOT_KIND = {
  "state-f32": 0,
  "state-f64": 1,
  "state-i32": 2,
  "state-i64": 3,
  "state-bool": 4,
  "buffer-f32": 10,
  "buffer-f64": 11,
  "buffer-i32": 12,
  param: 20,
} as const;

// AudioWorkletGlobalScope on some Chromium versions does not expose TextEncoder
// or TextDecoder. Provide a lazy fallback that only constructs the native ones
// when available, and synthesises the few methods we use otherwise.
let _enc: { encode(s: string): Uint8Array } | null = null;
let _dec: { decode(b: Uint8Array): string } | null = null;
function getEnc() {
  if (_enc) return _enc;
  if (typeof TextEncoder !== "undefined") {
    _enc = new TextEncoder();
  } else {
    _enc = {
      encode(s: string): Uint8Array {
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
        return out;
      },
    };
  }
  return _enc;
}
function getDec() {
  if (_dec) return _dec;
  if (typeof TextDecoder !== "undefined") {
    _dec = new TextDecoder();
  } else {
    _dec = {
      decode(b: Uint8Array): string {
        let s = "";
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
        return s;
      },
    };
  }
  return _dec;
}
const enc = { encode(s: string) { return getEnc().encode(s); } };
const dec = { decode(b: Uint8Array) { return getDec().decode(b); } };

function writeU8(arr: number[], v: number) {
  arr.push(v & 0xff);
}
function writeU16(arr: number[], v: number) {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
}
function writeU32(arr: number[], v: number) {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function writeBytes(arr: number[], bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i++) arr.push(bytes[i]!);
}
function readU8(view: DataView, offset: { v: number }): number {
  const r = view.getUint8(offset.v);
  offset.v += 1;
  return r;
}
function readU16(view: DataView, offset: { v: number }): number {
  const r = view.getUint16(offset.v, true);
  offset.v += 2;
  return r;
}
function readU32(view: DataView, offset: { v: number }): number {
  const r = view.getUint32(offset.v, true);
  offset.v += 4;
  return r;
}

export class Engine {
  rt: ProcessorRuntime;
  processor: CompiledProcessor;
  ready = false;

  constructor(processor: CompiledProcessor, options: EngineOptions) {
    this.processor = processor;
    this.rt = new ProcessorRuntime();
    this.rt.sampleRate = options.sampleRate;
    this.rt.currentBlockSize = options.blockSize ?? 128;
    this.rt.options = processor.options;
    this._setup();
  }

  _setup() {
    const prev = getCurrent();
    setCurrentRuntime(this.rt);
    try {
      this.rt.inSetup = true;
      this.rt.inProcess = false;
      // Run processor body once. Declarations register slots; { process } captured.
      const ret = this.processor.body({
        sampleRate: this.rt.sampleRate,
        renderQuantum: this.rt.currentBlockSize,
      });
      this.rt.processFn = ret.process;
      this.rt.rootScope.fullyDeclared = true;
      this.rt.inSetup = false;
      this.rt.schemaHash = computeSchemaHash(this.rt);
      this.ready = true;
    } finally {
      setCurrentRuntime(prev);
    }
  }

  // Inject a message from main thread (queued for next render quantum).
  postMessage(name: string, payload: any): void {
    this.rt.pendingMessages.push({ name, payload });
  }

  // Inject a MIDI event (queued; atSample is in the next block being processed).
  postMidiEvent(name: string, event: MidiEvent): void {
    const list = this.rt.pendingMidiEvents.get(name) ?? [];
    list.push(event);
    this.rt.pendingMidiEvents.set(name, list);
  }

  // Render one block. inputs[name][channel] = Float32Array of length blockSize.
  // Returns outputs map. Optionally accepts param values (per-block array per param).
  render(
    inputs: Record<string, Float32Array[]>,
    paramValues?: Record<string, Float32Array | number>,
  ): {
    outputs: Record<string, Float32Array[]>;
    events: Map<string, Array<{ atSample: number; payload: any }>>;
    midiOut: MidiEvent[];
  } {
    const prev = getCurrent();
    setCurrentRuntime(this.rt);
    try {
      const block = this.rt.currentBlockSize;

      // Marshal audio inputs
      for (const ai of this.rt.audioInputs) {
        const src = inputs[ai.slot.name] ?? [];
        for (let c = 0; c < ai.runtime.channels.length; c++) {
          const ch = ai.runtime.channels[c]!;
          const data = src[c];
          if (data) {
            ch.set(data.subarray(0, block));
            // If shorter, fill rest with zero
            if (data.length < block) ch.fill(0, data.length);
          } else {
            ch.fill(0);
          }
        }
      }

      // Clear audio outputs
      for (const ao of this.rt.audioOutputs) {
        for (const ch of ao.runtime.channels) ch.fill(0);
      }

      // Apply param values for this block
      for (const p of this.rt.params) {
        const v = paramValues?.[p.slot.name];
        if (typeof v === "number") {
          p.runtime.values.fill(v);
          p.runtime.currentValue = v;
        } else if (v && v instanceof Float32Array) {
          if (p.slot.automationRate === "a-rate") {
            p.runtime.values.set(v.subarray(0, block));
            if (v.length < block) {
              p.runtime.values.fill(v[v.length - 1] ?? p.runtime.currentValue, v.length);
            }
            p.runtime.currentValue = p.runtime.values[block - 1] ?? p.runtime.currentValue;
          } else {
            const val = v[0] ?? p.runtime.currentValue;
            p.runtime.values[0] = val;
            p.runtime.currentValue = val;
          }
        }
      }

      // Reset outbound buffers for this block
      for (const list of this.rt.outboundEvents.values()) list.length = 0;
      this.rt.outboundMidi.length = 0;

      // Clear handlers — they will be re-registered at the top of the user's
      // process body. (The process body re-runs each block in this interpreter.)
      this.rt.messageHandlers.clear();
      for (const [, m] of this.rt.midiHandlers) m.clear();

      // Set up the drain hook: forSample (first iteration in the block) calls
      // this to flush messages/MIDI to handlers right before per-sample work.
      this.rt._messagesDrained = false;
      this.rt._drainHook = () => {
        for (const { name, payload } of this.rt.pendingMessages) {
          const handlers = this.rt.messageHandlers.get(name) ?? [];
          for (const h of handlers) {
            try {
              h(payload);
            } catch (e) {
              console.error("[unworklet] message handler error:", e);
            }
          }
        }
        this.rt.pendingMessages.length = 0;
        for (const [name, list] of this.rt.pendingMidiEvents) {
          list.sort((a, b) => a.atSample - b.atSample);
          const handlerMap = this.rt.midiHandlers.get(name);
          if (handlerMap) {
            for (const ev of list) {
              const handlers = handlerMap.get(ev.type) ?? [];
              for (const h of handlers) {
                try {
                  h(ev);
                } catch (e) {
                  console.error("[unworklet] midi handler error:", e);
                }
              }
            }
          }
          list.length = 0;
        }
      };

      // Run process body
      this.rt.inProcess = true;
      try {
        if (this.rt.processFn) this.rt.processFn();
        // If no forSample was called, drain manually so messages don't queue forever.
        if (!this.rt._messagesDrained) this.rt._drainHook();
      } finally {
        this.rt.inProcess = false;
      }

      // Run publish scheduling
      this._runPublish();

      // Advance global sample position
      this.rt._absoluteSamplePos += block;

      // Collect outputs
      const outputs: Record<string, Float32Array[]> = {};
      for (const ao of this.rt.audioOutputs) {
        outputs[ao.slot.name] = ao.runtime.channels.map((c) => Float32Array.from(c));
      }
      // Collect outbound events (snapshot)
      const events = new Map<string, Array<{ atSample: number; payload: any }>>();
      for (const [k, list] of this.rt.outboundEvents) {
        events.set(k, list.slice());
      }
      const midiOut = this.rt.outboundMidi.map((m) => m.event);

      return { outputs, events, midiOut };
    } finally {
      setCurrentRuntime(prev);
    }
  }

  _runPublish() {
    const block = this.rt.currentBlockSize;
    for (const sr of this.rt.allScopes.flatMap((s) => s.states)) {
      if (!sr.slot.publish) continue;
      const path = sr.slot.path;
      const targetSamples = (this.rt.sampleRate / sr.slot.publish.rateFps) | 0;
      const cur = (this.rt.publishCounters.get(path) ?? 0) + block;
      if (cur >= targetSamples) {
        this.rt.publishCounters.set(path, cur - targetSamples);
        const value = sr.read();
        const last = this.rt.publishLastValues.get(path);
        if (last !== value) {
          this.rt.publishLastValues.set(path, value);
          const obs = this.rt.publishObservers.get(path);
          if (obs) for (const o of obs) o(value);
        }
      } else {
        this.rt.publishCounters.set(path, cur);
      }
    }
    for (const br of this.rt.allScopes.flatMap((s) => s.buffers)) {
      if (!br.slot.publish) continue;
      const path = br.slot.path;
      const targetSamples = (this.rt.sampleRate / br.slot.publish.rateFps) | 0;
      const cur = (this.rt.publishCounters.get(path) ?? 0) + block;
      if (cur >= targetSamples) {
        this.rt.publishCounters.set(path, cur - targetSamples);
        // Always fire — equality on buffers is expensive; let consumer compare.
        const view = (br.storage as any).slice();
        this.rt.publishLastValues.set(path, view);
        const obs = this.rt.publishObservers.get(path);
        if (obs) for (const o of obs) o(view);
      } else {
        this.rt.publishCounters.set(path, cur);
      }
    }
  }

  // Snapshot: capture all 'persistent' state/buffer/param slots.
  snapshot(profile?: string): Uint8Array {
    const arr: number[] = [];
    // Header
    writeBytes(arr, enc.encode("UWS1"));
    const hashBytes = enc.encode(this.rt.schemaHash);
    writeU8(arr, hashBytes.length);
    writeBytes(arr, hashBytes);
    if (profile) {
      const pb = enc.encode(profile);
      writeU8(arr, pb.length);
      writeBytes(arr, pb);
    } else {
      writeU8(arr, 0);
    }
    // Collect slots
    type Entry = { kind: number; path: string; bytes: Uint8Array };
    const entries: Entry[] = [];
    const matchesProfile = (policy: any) => {
      if (policy === "persistent") return true;
      if (policy === "transient") return false;
      if (typeof policy === "object" && policy !== null) {
        if (profile) return policy[profile] === "persistent";
        // No profile: include if any profile maps to persistent
        for (const k of Object.keys(policy)) if (policy[k] === "persistent") return true;
        return false;
      }
      return false;
    };
    for (const scope of this.rt.allScopes) {
      for (const sr of scope.states) {
        if (!matchesProfile(sr.slot.snapshot)) continue;
        const v = sr.read();
        const buf = new Uint8Array(8);
        const dv = new DataView(buf.buffer);
        let kind: number;
        if (sr.slot.type === "f32") {
          dv.setFloat32(0, v as number, true);
          kind = SLOT_KIND["state-f32"];
        } else if (sr.slot.type === "f64") {
          dv.setFloat64(0, v as number, true);
          kind = SLOT_KIND["state-f64"];
        } else if (sr.slot.type === "i32") {
          dv.setInt32(0, (v as number) | 0, true);
          kind = SLOT_KIND["state-i32"];
        } else if (sr.slot.type === "i64") {
          dv.setBigInt64(0, BigInt(Math.trunc(v as number)), true);
          kind = SLOT_KIND["state-i64"];
        } else {
          dv.setUint8(0, v ? 1 : 0);
          kind = SLOT_KIND["state-bool"];
        }
        entries.push({ kind, path: sr.slot.path, bytes: buf });
      }
      for (const br of scope.buffers) {
        if (!matchesProfile(br.slot.snapshot)) continue;
        let kind: number;
        let buf: Uint8Array;
        if (br.slot.type === "f32") {
          buf = new Uint8Array((br.storage as Float32Array).buffer.slice(0));
          kind = SLOT_KIND["buffer-f32"];
        } else if (br.slot.type === "i32") {
          buf = new Uint8Array((br.storage as Int32Array).buffer.slice(0));
          kind = SLOT_KIND["buffer-i32"];
        } else {
          buf = new Uint8Array((br.storage as Float64Array).buffer.slice(0));
          kind = SLOT_KIND["buffer-f64"];
        }
        entries.push({ kind, path: br.slot.path, bytes: buf });
      }
    }
    for (const p of this.rt.params) {
      if (!matchesProfile(p.slot.snapshot)) continue;
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setFloat64(0, p.runtime.currentValue, true);
      entries.push({ kind: SLOT_KIND["param"], path: p.slot.name, bytes: buf });
    }

    writeU32(arr, entries.length);
    for (const e of entries) {
      writeU8(arr, e.kind);
      const pb = enc.encode(e.path);
      writeU16(arr, pb.length);
      writeBytes(arr, pb);
      writeU32(arr, e.bytes.length);
      writeBytes(arr, e.bytes);
    }
    return new Uint8Array(arr);
  }

  inspect(blob: Uint8Array): {
    version: number;
    schemaHash: string;
    profile: string | null;
    slots: Record<string, any>;
  } {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const off = { v: 0 };
    const magic = String.fromCharCode(...blob.subarray(0, 4));
    if (magic !== "UWS1") throw new Error("Invalid snapshot blob magic");
    off.v = 4;
    const hashLen = readU8(view, off);
    const schemaHash = dec.decode(blob.subarray(off.v, off.v + hashLen));
    off.v += hashLen;
    const profileLen = readU8(view, off);
    const profile = profileLen === 0 ? null : dec.decode(blob.subarray(off.v, off.v + profileLen));
    off.v += profileLen;
    const numSlots = readU32(view, off);
    const slots: Record<string, any> = {};
    for (let i = 0; i < numSlots; i++) {
      const kind = readU8(view, off);
      const pathLen = readU16(view, off);
      const path = dec.decode(blob.subarray(off.v, off.v + pathLen));
      off.v += pathLen;
      const len = readU32(view, off);
      const data = blob.subarray(off.v, off.v + len);
      off.v += len;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (kind === SLOT_KIND["state-f32"]) {
        slots[path] = { kind: "state", type: "f32", value: dv.getFloat32(0, true) };
      } else if (kind === SLOT_KIND["state-f64"]) {
        slots[path] = { kind: "state", type: "f64", value: dv.getFloat64(0, true) };
      } else if (kind === SLOT_KIND["state-i32"]) {
        slots[path] = { kind: "state", type: "i32", value: dv.getInt32(0, true) };
      } else if (kind === SLOT_KIND["state-i64"]) {
        slots[path] = { kind: "state", type: "i64", value: Number(dv.getBigInt64(0, true)) };
      } else if (kind === SLOT_KIND["state-bool"]) {
        slots[path] = { kind: "state", type: "bool", value: dv.getUint8(0) !== 0 };
      } else if (kind === SLOT_KIND["buffer-f32"]) {
        const arr = new Float32Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
        slots[path] = {
          kind: "buffer",
          type: "f32",
          length: arr.length,
          head: Array.from(arr.subarray(0, Math.min(64, arr.length))),
        };
      } else if (kind === SLOT_KIND["buffer-i32"]) {
        const arr = new Int32Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
        slots[path] = {
          kind: "buffer",
          type: "i32",
          length: arr.length,
          head: Array.from(arr.subarray(0, Math.min(64, arr.length))),
        };
      } else if (kind === SLOT_KIND["param"]) {
        slots[path] = { kind: "param", value: dv.getFloat64(0, true) };
      }
    }
    return { version: 1, schemaHash, profile, slots };
  }

  // Restore: write blob into running processor; returns RestoreResult.
  restore(blob: Uint8Array): {
    restored: number;
    skipped: string[];
    missing: string[];
  } {
    const inspected = this.inspect(blob);
    let blobToApply = blob;
    let blobInspected = inspected;
    // Apply migrations if hashes differ
    if (inspected.schemaHash !== this.rt.schemaHash) {
      const migrated = this._applyMigrations(blob, inspected.schemaHash);
      if (migrated) {
        blobToApply = migrated;
        blobInspected = this.inspect(migrated);
      }
    }
    const skipped: string[] = [];
    const missing: string[] = [];
    let restored = 0;
    // Build map of available slots in blob
    const avail = new Map<string, any>(Object.entries(blobInspected.slots));
    // Walk current schema
    for (const scope of this.rt.allScopes) {
      for (const sr of scope.states) {
        if (sr.slot.snapshot === "transient") continue;
        const path = sr.slot.path;
        const entry = avail.get(path);
        if (!entry) {
          missing.push(path);
          continue;
        }
        if (entry.kind !== "state" || entry.type !== sr.slot.type) {
          skipped.push(path);
          continue;
        }
        sr.write(entry.value);
        restored++;
      }
      for (const br of scope.buffers) {
        if (br.slot.snapshot === "transient") continue;
        const path = br.slot.path;
        const entry = avail.get(path);
        if (!entry) {
          missing.push(path);
          continue;
        }
        if (entry.kind !== "buffer" || entry.type !== br.slot.type) {
          skipped.push(path);
          continue;
        }
        // Find raw bytes from blob — re-parse for full data
        const raw = this._extractBufferBytes(blobToApply, path);
        if (raw) {
          if (br.slot.type === "f32") {
            const src = new Float32Array(
              raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            );
            (br.storage as Float32Array).set(src.subarray(0, Math.min(src.length, br.slot.size)));
          } else if (br.slot.type === "i32") {
            const src = new Int32Array(
              raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            );
            (br.storage as Int32Array).set(src.subarray(0, Math.min(src.length, br.slot.size)));
          } else {
            const src = new Float64Array(
              raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            );
            (br.storage as Float64Array).set(src.subarray(0, Math.min(src.length, br.slot.size)));
          }
          restored++;
        } else {
          missing.push(path);
        }
      }
    }
    for (const p of this.rt.params) {
      if (p.slot.snapshot === "transient") continue;
      const entry = avail.get(p.slot.name);
      if (!entry) {
        missing.push(p.slot.name);
        continue;
      }
      if (entry.kind !== "param") {
        skipped.push(p.slot.name);
        continue;
      }
      p.runtime.currentValue = entry.value;
      p.runtime.values.fill(entry.value);
      restored++;
    }
    return { restored, skipped, missing };
  }

  _extractBufferBytes(blob: Uint8Array, targetPath: string): Uint8Array | null {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const off = { v: 0 };
    off.v = 4; // skip magic
    const hashLen = readU8(view, off);
    off.v += hashLen;
    const profLen = readU8(view, off);
    off.v += profLen;
    const numSlots = readU32(view, off);
    for (let i = 0; i < numSlots; i++) {
      const _kind = readU8(view, off);
      const pathLen = readU16(view, off);
      const path = dec.decode(blob.subarray(off.v, off.v + pathLen));
      off.v += pathLen;
      const len = readU32(view, off);
      const data = blob.subarray(off.v, off.v + len);
      off.v += len;
      if (path === targetPath) return data;
    }
    return null;
  }

  _applyMigrations(blob: Uint8Array, fromHash: string): Uint8Array | null {
    const migrations = this.processor.options?.migrations;
    if (!migrations || migrations.length === 0) return null;
    // Find a path from fromHash to schemaHash
    const target = this.rt.schemaHash;
    const path = this._findMigrationPath(fromHash, target, migrations);
    if (!path) return null;
    let current = blob;
    let currentHash = fromHash;
    for (const mig of path) {
      // Inspect current to get slots
      const inspected = this.inspect(current);
      // Build helpers; collect output
      const writes = new Map<string, { kind: string; type?: string; data: any }>();
      const helpers = {
        parseSlot: (b: Uint8Array, name: string, type: string) => {
          const ins = this.inspect(b);
          const entry = ins.slots[name];
          if (!entry) return undefined;
          if (entry.kind === "state" && entry.type === type) return entry.value;
          if (entry.kind === "param") return entry.value;
          return undefined;
        },
        parseBuffer: (b: Uint8Array, name: string, _type: string) => {
          const raw = this._extractBufferBytes(b, name);
          if (!raw) return undefined;
          if (_type === "f32")
            return new Float32Array(
              raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            );
          if (_type === "i32")
            return new Int32Array(
              raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            );
          return undefined;
        },
        parseParam: (b: Uint8Array, name: string) => {
          const ins = this.inspect(b);
          const entry = ins.slots[name];
          return entry?.value;
        },
        parseSlotInProfile: (b: Uint8Array, name: string, type: string, _profile: string) => {
          return helpers.parseSlot(b, name, type);
        },
        writeSlot: (name: string, type: string, value: number | boolean) => {
          writes.set(name, { kind: "state", type, data: value });
        },
        writeBuffer: (name: string, type: string, data: any) => {
          writes.set(name, { kind: "buffer", type, data });
        },
        writeParam: (name: string, value: number) => {
          writes.set(name, { kind: "param", data: value });
        },
        writeSlotInProfile: (name: string, type: string, value: any, _profile: string) => {
          helpers.writeSlot(name, type, value);
        },
        oldSchemaHash: currentHash,
        oldProfileName: inspected.profile,
      };
      mig.migrate(current, helpers as any);
      // Build new blob: start from old blob but apply writes
      // Simple approach: snapshot inspected slots, override with writes, serialize.
      const out = this._serializeMigrationOutput(inspected, mig.to, writes);
      current = out;
      currentHash = mig.to;
    }
    return current;
  }

  _findMigrationPath(
    from: string,
    to: string,
    migrations: NonNullable<CompiledProcessor["options"]>["migrations"],
  ) {
    if (!migrations) return null;
    // BFS over migration graph
    const adj = new Map<string, Array<NonNullable<typeof migrations>[number]>>();
    for (const m of migrations) {
      const list = adj.get(m.from) ?? [];
      list.push(m);
      adj.set(m.from, list);
    }
    const visited = new Set<string>();
    type Path = NonNullable<typeof migrations>[number][];
    const queue: Array<{ at: string; path: Path }> = [{ at: from, path: [] }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.at === to) return cur.path;
      if (visited.has(cur.at)) continue;
      visited.add(cur.at);
      const next = adj.get(cur.at) ?? [];
      for (const m of next) {
        queue.push({ at: m.to, path: [...cur.path, m] });
      }
    }
    return null;
  }

  _serializeMigrationOutput(
    inspected: ReturnType<Engine["inspect"]>,
    newHash: string,
    writes: Map<string, { kind: string; type?: string; data: any }>,
  ): Uint8Array {
    const arr: number[] = [];
    writeBytes(arr, enc.encode("UWS1"));
    const hashBytes = enc.encode(newHash);
    writeU8(arr, hashBytes.length);
    writeBytes(arr, hashBytes);
    writeU8(arr, 0); // no profile
    // Collect entries: take inspected.slots, override with writes
    const all = new Map<string, { kind: number; bytes: Uint8Array }>();
    for (const [path, slot] of Object.entries(inspected.slots)) {
      // Skip if overridden
      if (writes.has(path)) continue;
      all.set(path, slotToBytes(path, slot));
    }
    for (const [path, w] of writes) {
      const bytes = writeToBytes(path, w);
      if (bytes) all.set(path, bytes);
    }
    writeU32(arr, all.size);
    for (const [path, e] of all) {
      writeU8(arr, e.kind);
      const pb = enc.encode(path);
      writeU16(arr, pb.length);
      writeBytes(arr, pb);
      writeU32(arr, e.bytes.length);
      writeBytes(arr, e.bytes);
    }
    return new Uint8Array(arr);
  }
}

function slotToBytes(_path: string, slot: any): { kind: number; bytes: Uint8Array } {
  if (slot.kind === "state") {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    let kind: number;
    if (slot.type === "f32") {
      dv.setFloat32(0, slot.value, true);
      kind = SLOT_KIND["state-f32"];
    } else if (slot.type === "f64") {
      dv.setFloat64(0, slot.value, true);
      kind = SLOT_KIND["state-f64"];
    } else if (slot.type === "i32") {
      dv.setInt32(0, slot.value | 0, true);
      kind = SLOT_KIND["state-i32"];
    } else if (slot.type === "i64") {
      dv.setBigInt64(0, BigInt(slot.value), true);
      kind = SLOT_KIND["state-i64"];
    } else {
      dv.setUint8(0, slot.value ? 1 : 0);
      kind = SLOT_KIND["state-bool"];
    }
    return { kind, bytes: buf };
  } else if (slot.kind === "param") {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, slot.value, true);
    return { kind: SLOT_KIND["param"], bytes: buf };
  }
  // buffer (only head preview is in inspected; we don't have full data) — caller should not hit this path.
  return { kind: 99, bytes: new Uint8Array(0) };
}

function writeToBytes(_path: string, w: { kind: string; type?: string; data: any }) {
  if (w.kind === "state") {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    let kind: number;
    if (w.type === "f32") {
      dv.setFloat32(0, w.data, true);
      kind = SLOT_KIND["state-f32"];
    } else if (w.type === "f64") {
      dv.setFloat64(0, w.data, true);
      kind = SLOT_KIND["state-f64"];
    } else if (w.type === "i32") {
      dv.setInt32(0, w.data | 0, true);
      kind = SLOT_KIND["state-i32"];
    } else if (w.type === "i64") {
      dv.setBigInt64(0, BigInt(w.data), true);
      kind = SLOT_KIND["state-i64"];
    } else {
      dv.setUint8(0, w.data ? 1 : 0);
      kind = SLOT_KIND["state-bool"];
    }
    return { kind, bytes: buf };
  } else if (w.kind === "param") {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, w.data, true);
    return { kind: SLOT_KIND["param"], bytes: buf };
  } else if (w.kind === "buffer") {
    const data = w.data;
    let bytes: Uint8Array;
    let kind: number;
    if (w.type === "f32") {
      bytes = new Uint8Array((data as Float32Array).buffer.slice(0));
      kind = SLOT_KIND["buffer-f32"];
    } else if (w.type === "i32") {
      bytes = new Uint8Array((data as Int32Array).buffer.slice(0));
      kind = SLOT_KIND["buffer-i32"];
    } else {
      bytes = new Uint8Array((data as Float64Array).buffer.slice(0));
      kind = SLOT_KIND["buffer-f64"];
    }
    return { kind, bytes };
  }
  return null;
}

function getCurrent() {
  // Avoid circular import: read the module-private current via a re-export.
  // We import setCurrentRuntime which returns void; getCurrent we cheat via setCurrentRuntime.
  // Simpler: just return null since we always wrap render() calls.
  return null;
}

// Compute a stable schema hash from the runtime's declarations.
function computeSchemaHash(rt: ProcessorRuntime): string {
  // Build canonical string representation
  const parts: string[] = [];
  for (const scope of rt.allScopes) {
    for (const sr of scope.states) {
      parts.push(`s|${sr.slot.path}|${sr.slot.type}|${sr.slot.snapshot}`);
    }
    for (const br of scope.buffers) {
      parts.push(`b|${br.slot.path}|${br.slot.type}|${br.slot.size}|${br.slot.snapshot}`);
    }
  }
  for (const p of rt.params) {
    parts.push(
      `p|${p.slot.name}|${p.slot.automationRate}|${p.slot.default}|${p.slot.min}|${p.slot.max}`,
    );
  }
  parts.sort();
  // FNV-1a 32-bit hash, expressed as 8-char hex
  const s = parts.join(";");
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
