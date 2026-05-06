// Generates a per-processor AudioWorklet module JS source — to be served
// via addModule() so the worklet can host a compiled WASM processor.
//
// Per docs/03-compiler.md §5 and draft_spec §7.4: the worklet wraps the WASM
// binary, exposes static parameterDescriptors derived from the user's
// processor declarations, marshals I/O between linear memory and the
// AudioWorklet's inputs/outputs/parameters arrays, and dispatches messages /
// MIDI events through the worklet's port.

import type { CapturedGraph } from "./ast.js";
import type { MemoryLayout } from "./memory-layout.js";

export type WorkletModuleOptions = {
  processorName: string;
};

// Encode a Uint8Array as a Base64 string — used to embed the compiled WASM
// binary into the generated worklet source.
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  // btoa is not available in Node by default; use Buffer when present.
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(bytes).toString("base64");
}

export function generateWorkletModule(
  graph: CapturedGraph,
  layout: MemoryLayout,
  binary: Uint8Array,
  options: WorkletModuleOptions,
): string {
  const paramDescs = graph.declarations.params.map((p) => ({
    name: p.name,
    defaultValue: p.default,
    minValue: p.min,
    maxValue: p.max,
    automationRate: p.automationRate,
  }));

  // Layout summary the worklet needs to marshal I/O.
  const layoutSummary = {
    audioInputs: layout.audioInputs.inputs.map((ai) => ({
      offset: ai.offset,
      channels: ai.channels,
      channelStride: ai.channelStride,
    })),
    audioOutputs: layout.audioOutputs.outputs.map((ao) => ({
      offset: ao.offset,
      channels: ao.channels,
      channelStride: ao.channelStride,
    })),
    params: layout.params.layouts.map((pl) => {
      const decl = graph.declarations.params.find((p) => p.id === pl.paramId)!;
      return {
        name: decl.name,
        offset: pl.offset,
        automationRate: pl.automationRate,
      };
    }),
    events: layout.events.layouts.map((el) => {
      const decl = graph.declarations.events.find((e) => e.id === el.eventId)!;
      return {
        name: decl.name,
        capacity: el.capacity,
        headerOffset: el.headerOffset,
        slotsOffset: el.slotsOffset,
        slotSize: el.slotSize,
        fields: decl.fields,
        fieldOffsets: el.fieldOffsets,
      };
    }),
    messages: layout.messages.layouts.map((ml) => {
      const decl = graph.declarations.messages.find((m) => m.id === ml.messageId)!;
      return {
        name: decl.name,
        capacity: ml.capacity,
        headerOffset: ml.headerOffset,
        slotsOffset: ml.slotsOffset,
        slotSize: ml.slotSize,
        fields: decl.fields,
        fieldOffsets: ml.fieldOffsets,
        payloadFields: ml.payloadFields,
        payloadStridePerSlot: ml.payloadStridePerSlot,
        payloadBufferOffset: ml.payloadBufferOffset,
        payloadBufferBytes: ml.payloadBufferBytes,
      };
    }),
    midiInputs: layout.midiInputs.layouts.map((ml) => {
      const decl = graph.declarations.midiInputs.find((m) => m.id === ml.midiId)!;
      return {
        name: decl.name,
        capacity: ml.capacity,
        headerOffset: ml.headerOffset,
        slotsOffset: ml.slotsOffset,
      };
    }),
    midiOutputs: layout.midiOutputs.layouts.map((ml) => {
      const decl = graph.declarations.midiOutputs.find((m) => m.id === ml.midiId)!;
      return {
        name: decl.name,
        capacity: ml.capacity,
        headerOffset: ml.headerOffset,
        slotsOffset: ml.slotsOffset,
      };
    }),
    publishedStates: layout.stateRegion.slots
      .map((sl) => {
        const decl = graph.declarations.states.find((s) => s.id === sl.slotId)!;
        if (!decl.publish) return null;
        return {
          path: decl.path,
          name: decl.name ?? decl.path,
          type: sl.type,
          offset: sl.offset,
          rateFps: decl.publish.rateFps,
        };
      })
      .filter(Boolean),
    publishedBuffers: layout.bufferRegion.buffers
      .map((bl) => {
        const decl = graph.declarations.buffers.find((b) => b.id === bl.bufferId)!;
        if (!decl.publish) return null;
        return {
          path: decl.path,
          name: decl.name ?? decl.path,
          type: bl.type,
          offset: bl.offset,
          size: bl.size,
          byteSize: bl.byteSize,
          rateFps: decl.publish.rateFps,
        };
      })
      .filter(Boolean),
    stateRegion: {
      offset: layout.stateRegion.offset,
      size: layout.stateRegion.size,
      slots: layout.stateRegion.slots.map((sl) => {
        const decl = graph.declarations.states.find((s) => s.id === sl.slotId)!;
        return {
          slotId: sl.slotId,
          path: decl.path,
          type: sl.type,
          offset: sl.offset,
          snapshot: decl.snapshot,
        };
      }),
    },
    bufferRegion: {
      offset: layout.bufferRegion.offset,
      size: layout.bufferRegion.size,
      buffers: layout.bufferRegion.buffers.map((bl) => {
        const decl = graph.declarations.buffers.find((b) => b.id === bl.bufferId)!;
        return {
          bufferId: bl.bufferId,
          path: decl.path,
          type: bl.type,
          offset: bl.offset,
          size: bl.size,
          byteSize: bl.byteSize,
          snapshot: decl.snapshot,
        };
      }),
    },
    mathTables: (layout as any).mathTables ?? [],
    renderQuantum: layout.renderQuantum,
    schemaHash: graph.schemaHash,
  };

  const paramDescsJson = JSON.stringify(paramDescs);
  const layoutJson = JSON.stringify(layoutSummary);
  const wasmB64 = toBase64(binary);
  const procName = options.processorName;

  return `// Auto-generated unworklet worklet module for processor "${procName}".
"use strict";
(() => {
  const PARAM_DESCS = ${paramDescsJson};
  const LAYOUT = ${layoutJson};
  const WASM_B64 = "${wasmB64}";

  // AudioWorkletGlobalScope doesn't expose atob; decode base64 manually.
  function b64ToBytes(b64) {
    const lut = new Uint8Array(128);
    const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let i = 0; i < table.length; i++) lut[table.charCodeAt(i)] = i;
    let pad = 0;
    if (b64.charCodeAt(b64.length - 1) === 61) pad++;
    if (b64.charCodeAt(b64.length - 2) === 61) pad++;
    const outLen = (b64.length / 4) * 3 - pad;
    const out = new Uint8Array(outLen);
    let o = 0;
    for (let i = 0; i < b64.length; i += 4) {
      const a = lut[b64.charCodeAt(i)];
      const b = lut[b64.charCodeAt(i + 1)];
      const c = lut[b64.charCodeAt(i + 2)];
      const d = lut[b64.charCodeAt(i + 3)];
      const v = (a << 18) | (b << 12) | (c << 6) | d;
      if (o < outLen) out[o++] = (v >> 16) & 0xff;
      if (o < outLen) out[o++] = (v >> 8) & 0xff;
      if (o < outLen) out[o++] = v & 0xff;
    }
    return out;
  }

  class UnworkletWasmProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() { return PARAM_DESCS; }

    constructor() {
      super();
      try {
        const binary = b64ToBytes(WASM_B64);
        const mod = new WebAssembly.Module(binary);
        const inst = new WebAssembly.Instance(mod, {
          math: {
            sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
            exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
          },
        });
        this.exports = inst.exports;
        // Populate any /table math approximation tables before init so the
        // first call to process can use them (docs/01-dsl §2 / spec Q17).
        const memMath = new Float32Array(this.exports.memory.buffer);
        for (const tbl of LAYOUT.mathTables) {
          const off = tbl.offset >> 2;
          if (tbl.kind === "sin") {
            for (let i = 0; i < tbl.length; i++) memMath[off + i] = Math.sin((2 * Math.PI * i) / tbl.length);
          } else if (tbl.kind === "exp") {
            for (let i = 0; i < tbl.length; i++) memMath[off + i] = Math.exp((i / tbl.length) * Math.LN2);
          } else if (tbl.kind === "log") {
            for (let i = 0; i < tbl.length; i++) memMath[off + i] = Math.log(1 + i / tbl.length);
          }
        }
        this.exports.init();
        // Pre-warm: gate JIT tier-up before audio starts (docs/04 §1 step 4).
        try { this.exports.prewarm?.(256); } catch {}
        this.mem = new Float32Array(this.exports.memory.buffer);
        this.memU8 = new Uint8Array(this.exports.memory.buffer);
        this.memI32 = new Int32Array(this.exports.memory.buffer);
        this._eventReadHeads = new Map();
        this._midiOutReadHeads = new Map();
        this._publishCounters = new Map();
        this._publishLast = new Map();
        // Shared linear memory enables Atomics-based ring updates from the
        // main thread (docs/02 §4). memory.buffer is a SharedArrayBuffer
        // because we compiled with shared=true.
        const memBuf = this.exports.memory.buffer;
        const sharedTransport = typeof SharedArrayBuffer !== "undefined" && memBuf instanceof SharedArrayBuffer;
        this._sab = sharedTransport;
        this.port.onmessage = (e) => this._onMessage(e.data);
        this.port.postMessage({
          type: "ready",
          layout: LAYOUT,
          paramDescs: PARAM_DESCS,
          memory: sharedTransport ? memBuf : null,
          transport: sharedTransport ? "sab" : "postMessage",
        });
      } catch (err) {
        this._initError = err;
        try {
          this.port.postMessage({
            type: "init-error",
            message: (err && (err.message || String(err))) || "unknown",
            stack: err && err.stack ? String(err.stack) : null,
          });
        } catch {}
        throw err;
      }
    }

    _onMessage(msg) {
      if (!msg) return;
      if (msg.type === "message") this._enqueueMessage(msg.name, msg.payload);
      else if (msg.type === "midi") this._enqueueMidi(msg.event);
      else if (msg.type === "snapshot") this._handleSnapshot(msg.id, msg.profile);
      else if (msg.type === "restore") this._handleRestore(msg.id, msg.blob);
    }

    _handleSnapshot(id, _profile) {
      // docs/05-client §2.6: snapshot serializes the persistent state region
      // and (optionally) buffers, including a schemaHash so a later restore
      // can reject mismatched processors.
      const stateBytes = LAYOUT.stateRegion.size | 0;
      const persistentBuffers = LAYOUT.bufferRegion.buffers.filter(
        (b) => b.snapshot === "persistent",
      );
      let bufBytes = 0;
      for (const b of persistentBuffers) bufBytes += b.byteSize;
      const headerSize = 8 + 4 + LAYOUT.schemaHash.length + 4 + 4;
      const total = headerSize + stateBytes + 4 + persistentBuffers.length * 8 + bufBytes;
      const out = new Uint8Array(total);
      const dv = new DataView(out.buffer);
      let p = 0;
      out[p++] = 0x55; out[p++] = 0x57; out[p++] = 0x53; out[p++] = 0x4e; // 'UWSN'
      dv.setUint32(p, 1, true); p += 4; // version
      dv.setUint32(p, LAYOUT.schemaHash.length, true); p += 4;
      for (let i = 0; i < LAYOUT.schemaHash.length; i++) out[p + i] = LAYOUT.schemaHash.charCodeAt(i);
      p += LAYOUT.schemaHash.length;
      dv.setUint32(p, stateBytes, true); p += 4;
      out.set(this.memU8.subarray(LAYOUT.stateRegion.offset, LAYOUT.stateRegion.offset + stateBytes), p);
      p += stateBytes;
      dv.setUint32(p, persistentBuffers.length, true); p += 4;
      for (const b of persistentBuffers) {
        dv.setUint32(p, b.bufferId, true); p += 4;
        dv.setUint32(p, b.byteSize, true); p += 4;
        out.set(this.memU8.subarray(b.offset, b.offset + b.byteSize), p);
        p += b.byteSize;
      }
      this.port.postMessage({ type: "snapshot-response", id, blob: out.subarray(0, p) }, [out.buffer]);
    }

    _handleRestore(id, blob) {
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      let p = 0;
      const ok = blob[0] === 0x55 && blob[1] === 0x57 && blob[2] === 0x53 && blob[3] === 0x4e;
      if (!ok) {
        this.port.postMessage({ type: "restore-response", id, result: { restored: 0, skipped: [], missing: [], error: "bad-magic" } });
        return;
      }
      p = 4;
      const version = dv.getUint32(p, true); p += 4;
      if (version !== 1) {
        this.port.postMessage({ type: "restore-response", id, result: { restored: 0, skipped: [], missing: [], error: "bad-version" } });
        return;
      }
      const hashLen = dv.getUint32(p, true); p += 4;
      let hash = "";
      for (let i = 0; i < hashLen; i++) hash += String.fromCharCode(blob[p + i]);
      p += hashLen;
      if (hash !== LAYOUT.schemaHash) {
        this.port.postMessage({ type: "restore-response", id, result: { restored: 0, skipped: ["schema-mismatch"], missing: [], error: "schema-mismatch" } });
        return;
      }
      const stateBytes = dv.getUint32(p, true); p += 4;
      this.memU8.set(blob.subarray(p, p + stateBytes), LAYOUT.stateRegion.offset);
      p += stateBytes;
      const nBufs = dv.getUint32(p, true); p += 4;
      let restored = 1; const skipped = []; const missing = [];
      for (let i = 0; i < nBufs; i++) {
        const bid = dv.getUint32(p, true); p += 4;
        const bsize = dv.getUint32(p, true); p += 4;
        const layout = LAYOUT.bufferRegion.buffers.find((b) => b.bufferId === bid);
        if (!layout || layout.byteSize !== bsize || layout.snapshot !== "persistent") {
          skipped.push("buf:" + bid);
          p += bsize;
          continue;
        }
        this.memU8.set(blob.subarray(p, p + bsize), layout.offset);
        p += bsize;
        restored++;
      }
      this.port.postMessage({ type: "restore-response", id, result: { restored, skipped, missing } });
    }

    _enqueueMessage(name, payload) {
      const ml = LAYOUT.messages.find((m) => m.name === name);
      if (!ml) return;
      // Write into ring buffer at head; advance head. Use Atomics on the ring
      // headers per docs/02 §4 so the audio-thread reader sees a coherent
      // (head, slot) update.
      const headIdx = ml.headerOffset >> 2;
      const tailIdx = (ml.headerOffset + 4) >> 2;
      const overflowIdx = (ml.headerOffset + 8) >> 2;
      const sab = this._sab;
      const head = sab ? Atomics.load(this.memI32, headIdx) : this.memI32[headIdx];
      const tail = sab ? Atomics.load(this.memI32, tailIdx) : this.memI32[tailIdx];
      const slotIdx = head % ml.capacity;
      const slotPtr = ml.slotsOffset + slotIdx * ml.slotSize;
      // Drop-oldest if full
      if (head + 1 - tail >= ml.capacity) {
        if (sab) {
          Atomics.add(this.memI32, overflowIdx, 1);
          Atomics.store(this.memI32, tailIdx, tail + 1);
        } else {
          this.memI32[overflowIdx] += 1;
          this.memI32[tailIdx] = tail + 1;
        }
      }
      // Write fields
      for (const field of ml.fields) {
        const off = ml.fieldOffsets[field.name];
        if (!off) continue;
        const v = payload?.[field.name];
        if (typeof v !== "number" && typeof v !== "boolean") continue;
        if (off.type === "f32") {
          this.mem[(slotPtr + off.offset) / 4] = +v;
        } else if (off.type === "i32" || off.type === "bool") {
          this.memI32[(slotPtr + off.offset) / 4] = v | 0;
        }
      }
      // Write typed-array payload fields into the per-slot content area.
      const payloadFields = ml.payloadFields ?? [];
      if (payloadFields.length > 0) {
        const slotPayloadBase = ml.payloadBufferOffset + slotIdx * ml.payloadStridePerSlot;
        for (const pf of payloadFields) {
          const arr = payload?.[pf.name];
          const fieldBase = slotPayloadBase + pf.fieldOffsetWithinPayload;
          // Always write the slot offset/length scalars so the WASM reader
          // sees a consistent slot even if the field is omitted.
          this.memI32[(slotPtr + pf.slotOffsetField) / 4] = fieldBase;
          if (!arr || (
            !(arr instanceof Float32Array) &&
            !(arr instanceof Int32Array) &&
            !(arr instanceof Uint8Array)
          )) {
            this.memI32[(slotPtr + pf.slotLengthField) / 4] = 0;
            continue;
          }
          const len = Math.min(arr.length, pf.maxLength);
          this.memI32[(slotPtr + pf.slotLengthField) / 4] = len;
          if (pf.elemType === "f32") {
            const v = arr.length === len ? arr : arr.subarray(0, len);
            this.mem.set(v, fieldBase >> 2);
          } else if (pf.elemType === "i32") {
            const v = arr.length === len ? arr : arr.subarray(0, len);
            this.memI32.set(v, fieldBase >> 2);
          } else {
            // u8
            this.memU8.set(arr.subarray(0, len), fieldBase);
          }
        }
      }
      if (sab) Atomics.add(this.memI32, headIdx, 1);
      else this.memI32[headIdx] = head + 1;
    }

    _enqueueMidi(ev) {
      const inp = LAYOUT.midiInputs[0];
      if (!inp) return;
      const sab = this._sab;
      const headIdx = inp.headerOffset >> 2;
      const tailIdx = (inp.headerOffset + 4) >> 2;
      const overflowIdx = (inp.headerOffset + 8) >> 2;
      const head = sab ? Atomics.load(this.memI32, headIdx) : this.memI32[headIdx];
      const tail = sab ? Atomics.load(this.memI32, tailIdx) : this.memI32[tailIdx];
      const slotIdx = head % inp.capacity;
      const slotPtr = inp.slotsOffset + slotIdx * 8;
      if (head + 1 - tail >= inp.capacity) {
        if (sab) {
          Atomics.add(this.memI32, overflowIdx, 1);
          Atomics.store(this.memI32, tailIdx, tail + 1);
        } else {
          this.memI32[overflowIdx] += 1;
          this.memI32[tailIdx] = tail + 1;
        }
      }
      // Encode midi event to status / data1 / data2
      let status = 0, data1 = 0, data2 = 0;
      const ch = (ev.channel ?? 0) & 0x0f;
      switch (ev.type) {
        case "noteOn":  status = 0x90 | ch; data1 = ev.note ?? 0; data2 = ev.velocity ?? 0; break;
        case "noteOff": status = 0x80 | ch; data1 = ev.note ?? 0; data2 = ev.velocity ?? 0; break;
        case "cc":      status = 0xb0 | ch; data1 = ev.controller ?? 0; data2 = ev.value ?? 0; break;
        case "pitchBend": status = 0xe0 | ch; data1 = (ev.value ?? 0) & 0x7f; data2 = ((ev.value ?? 0) >> 7) & 0x7f; break;
        case "programChange": status = 0xc0 | ch; data1 = ev.program ?? 0; break;
        case "channelPressure": status = 0xd0 | ch; data1 = ev.pressure ?? 0; break;
        case "aftertouch": status = 0xa0 | ch; data1 = ev.note ?? 0; data2 = ev.pressure ?? 0; break;
        case "systemRealtime": status = ev.status ?? 0; break;
      }
      this.memU8[slotPtr + 0] = status & 0xff;
      this.memU8[slotPtr + 1] = data1 & 0xff;
      this.memU8[slotPtr + 2] = data2 & 0xff;
      this.memU8[slotPtr + 3] = 0;
      this.memI32[(slotPtr + 4) >> 2] = (ev.atSample ?? 0) | 0;
      if (sab) Atomics.add(this.memI32, headIdx, 1);
      else this.memI32[headIdx] = head + 1;
    }

    _drainOutboundEvents() {
      let any = false;
      const eventsOut = {};
      const sab = this._sab;
      for (const ev of LAYOUT.events) {
        const headIdx = ev.headerOffset >> 2;
        const head = sab ? Atomics.load(this.memI32, headIdx) : this.memI32[headIdx];
        const last = this._eventReadHeads.get(ev.name) ?? 0;
        // Read entries from last to head
        if (head !== last) {
          const list = [];
          for (let n = last; n < head; n++) {
            const slotIdx = n % ev.capacity;
            const slotPtr = ev.slotsOffset + slotIdx * ev.slotSize;
            const atSample = this.memI32[slotPtr / 4];
            const payload = { atSample };
            for (const f of ev.fields) {
              const off = ev.fieldOffsets[f.name];
              if (!off) continue;
              if (f.type === "f32") payload[f.name] = this.mem[(slotPtr + off.offset) / 4];
              else if (f.type === "i32" || f.type === "bool") payload[f.name] = this.memI32[(slotPtr + off.offset) / 4];
            }
            list.push(payload);
          }
          eventsOut[ev.name] = list;
          any = true;
          this._eventReadHeads.set(ev.name, head);
        }
      }
      if (any) this.port.postMessage({ type: "events", events: eventsOut });
    }

    _drainOutboundMidi() {
      const out = LAYOUT.midiOutputs[0];
      if (!out) return;
      const sab = this._sab;
      const headIdx = out.headerOffset >> 2;
      const head = sab ? Atomics.load(this.memI32, headIdx) : this.memI32[headIdx];
      const last = this._midiOutReadHeads.get(out.name) ?? 0;
      if (head === last) return;
      const events = [];
      for (let n = last; n < head; n++) {
        const slotIdx = n % out.capacity;
        const slotPtr = out.slotsOffset + slotIdx * 8;
        const status = this.memU8[slotPtr];
        const data1 = this.memU8[slotPtr + 1];
        const data2 = this.memU8[slotPtr + 2];
        const atSample = this.memI32[(slotPtr + 4) / 4];
        const high = status & 0xf0;
        const channel = status & 0x0f;
        let ev = null;
        if (high === 0x90) ev = data2 === 0 ? { type: "noteOff", channel, note: data1, velocity: 0, atSample } : { type: "noteOn", channel, note: data1, velocity: data2, atSample };
        else if (high === 0x80) ev = { type: "noteOff", channel, note: data1, velocity: data2, atSample };
        else if (high === 0xb0) ev = { type: "cc", channel, controller: data1, value: data2, atSample };
        else if (high === 0xe0) ev = { type: "pitchBend", channel, value: (data2 << 7) | data1, atSample };
        else if (high === 0xc0) ev = { type: "programChange", channel, program: data1, atSample };
        else if (high === 0xd0) ev = { type: "channelPressure", channel, pressure: data1, atSample };
        else if (high === 0xa0) ev = { type: "aftertouch", channel, note: data1, pressure: data2, atSample };
        else if (status >= 0xf8 && status <= 0xfc) ev = { type: "systemRealtime", status, atSample };
        if (ev) events.push({ event: ev });
      }
      this._midiOutReadHeads.set(out.name, head);
      if (events.length) this.port.postMessage({ type: "midi-out", events });
    }

    process(inputs, outputs, parameters) {
      const block = LAYOUT.renderQuantum;
      // Marshal inputs into linear memory
      for (let p = 0; p < LAYOUT.audioInputs.length; p++) {
        const ai = LAYOUT.audioInputs[p];
        const inSrc = inputs[p];
        for (let c = 0; c < ai.channels; c++) {
          const dstStart = (ai.offset + c * ai.channelStride) >> 2;
          const src = inSrc?.[c];
          if (src && src.length > 0) {
            this.mem.set(src.length === block ? src : src.subarray(0, block), dstStart);
            if (src.length < block) this.mem.fill(0, dstStart + src.length, dstStart + block);
          } else {
            // Repeat the available channel (Web Audio standard up-mix)
            const fb = inSrc?.[inSrc.length - 1];
            if (fb && fb.length > 0) {
              this.mem.set(fb.subarray(0, block), dstStart);
              if (fb.length < block) this.mem.fill(0, dstStart + fb.length, dstStart + block);
            } else {
              this.mem.fill(0, dstStart, dstStart + block);
            }
          }
        }
      }
      // Marshal params into linear memory
      for (const pl of LAYOUT.params) {
        const arr = parameters[pl.name];
        if (!arr) continue;
        const dstStart = pl.offset >> 2;
        if (pl.automationRate === "a-rate") {
          if (arr.length === 1) {
            for (let i = 0; i < block; i++) this.mem[dstStart + i] = arr[0];
          } else {
            this.mem.set(arr.length === block ? arr : arr.subarray(0, block), dstStart);
          }
        } else {
          this.mem[dstStart] = arr[0];
        }
      }
      // Run WASM process. Per docs/04 §8 / draft_spec §8.6: a runtime trap
      // outputs silence + emits an error event but does not stop the audio
      // thread (until the host calls dispose).
      try {
        this.exports.process(block);
      } catch (err) {
        if (!this._trapped) {
          this._trapped = true;
          this.port.postMessage({
            type: "error",
            kind: "wasm-trap",
            message: String(err),
          });
        }
        // Output silence
        for (let p = 0; p < LAYOUT.audioOutputs.length; p++) {
          const dst = outputs[p];
          if (!dst) continue;
          for (let c = 0; c < dst.length; c++) dst[c].fill(0);
        }
        return true;
      }
      // Marshal outputs out
      for (let p = 0; p < LAYOUT.audioOutputs.length; p++) {
        const ao = LAYOUT.audioOutputs[p];
        const dst = outputs[p];
        if (!dst) continue;
        for (let c = 0; c < ao.channels && c < dst.length; c++) {
          const srcStart = (ao.offset + c * ao.channelStride) >> 2;
          dst[c].set(this.mem.subarray(srcStart, srcStart + block));
        }
      }
      // Drain outbound events / midi
      this._drainOutboundEvents();
      this._drainOutboundMidi();
      // Drain published state / buffer slots — docs/02-messaging §5.4 +
      // 04-worklet-runtime §7. Each slot has its own per-FPS counter; only
      // emit when the value (or buffer view) changed since the last publish.
      this._drainPublishedState(block);
      return true;
    }

    _drainPublishedState(block) {
      const sr = sampleRate || 48000;
      const out = {};
      let any = false;
      for (const sl of LAYOUT.publishedStates) {
        const target = (sr / sl.rateFps) | 0;
        const cur = (this._publishCounters.get(sl.path) ?? 0) + block;
        if (cur < target) {
          this._publishCounters.set(sl.path, cur);
          continue;
        }
        this._publishCounters.set(sl.path, cur - target);
        let v;
        if (sl.type === "f32") v = this.mem[sl.offset >> 2];
        else if (sl.type === "f64") v = new Float64Array(this.exports.memory.buffer, sl.offset, 1)[0];
        else if (sl.type === "i32" || sl.type === "bool") v = this.memI32[sl.offset >> 2];
        else if (sl.type === "i64") {
          const lo = this.memI32[sl.offset >> 2];
          const hi = this.memI32[(sl.offset >> 2) + 1];
          v = (BigInt(hi) << 32n) | (BigInt(lo) & 0xffffffffn);
          v = Number(v);
        }
        if (sl.type === "bool") v = !!v;
        if (this._publishLast.get(sl.path) !== v) {
          this._publishLast.set(sl.path, v);
          out[sl.path] = v;
          any = true;
        }
      }
      for (const bl of LAYOUT.publishedBuffers) {
        const target = (sr / bl.rateFps) | 0;
        const cur = (this._publishCounters.get(bl.path) ?? 0) + block;
        if (cur < target) {
          this._publishCounters.set(bl.path, cur);
          continue;
        }
        this._publishCounters.set(bl.path, cur - target);
        // Buffers always fire (consumer compares).
        let view;
        if (bl.type === "f32") view = new Float32Array(this.exports.memory.buffer, bl.offset, bl.size).slice();
        else if (bl.type === "i32") view = new Int32Array(this.exports.memory.buffer, bl.offset, bl.size).slice();
        else view = new Uint8Array(this.exports.memory.buffer, bl.offset, bl.byteSize).slice();
        out[bl.path] = view;
        any = true;
      }
      if (any) this.port.postMessage({ type: "publish", values: out });
    }
  }

  registerProcessor(${JSON.stringify(`uw:${procName}`)}, UnworkletWasmProcessor);
})();
`;
}

// Convenience helper: take everything you need to load the worklet via Blob URL.
export type WorkletBundle = {
  source: string;
  binarySize: number;
  paramDescriptors: Array<{
    name: string;
    defaultValue: number;
    minValue: number;
    maxValue: number;
    automationRate: "a-rate" | "k-rate";
  }>;
};

export function generateWorkletBundle(
  graph: CapturedGraph,
  layout: MemoryLayout,
  binary: Uint8Array,
  options: WorkletModuleOptions,
): WorkletBundle {
  return {
    source: generateWorkletModule(graph, layout, binary, options),
    binarySize: binary.length,
    paramDescriptors: graph.declarations.params.map((p) => ({
      name: p.name,
      defaultValue: p.default,
      minValue: p.min,
      maxValue: p.max,
      automationRate: p.automationRate,
    })),
  };
}
