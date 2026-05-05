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
    renderQuantum: layout.renderQuantum,
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

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  class UnworkletWasmProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() { return PARAM_DESCS; }

    constructor() {
      super();
      const binary = b64ToBytes(WASM_B64);
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod, {
        math: {
          sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
          exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
        },
      });
      this.exports = inst.exports;
      this.exports.init();
      this.mem = new Float32Array(this.exports.memory.buffer);
      this.memU8 = new Uint8Array(this.exports.memory.buffer);
      this.memI32 = new Int32Array(this.exports.memory.buffer);
      this._eventReadHeads = new Map();
      this._midiOutReadHeads = new Map();
      this.port.onmessage = (e) => this._onMessage(e.data);
      this.port.postMessage({
        type: "ready",
        layout: LAYOUT,
        paramDescs: PARAM_DESCS,
      });
    }

    _onMessage(msg) {
      if (!msg) return;
      if (msg.type === "message") this._enqueueMessage(msg.name, msg.payload);
      else if (msg.type === "midi") this._enqueueMidi(msg.event);
    }

    _enqueueMessage(name, payload) {
      const ml = LAYOUT.messages.find((m) => m.name === name);
      if (!ml) return;
      // Write into ring buffer at head; advance head.
      const headOff = ml.headerOffset;
      const tailOff = ml.headerOffset + 4;
      const overflowOff = ml.headerOffset + 8;
      let head = this.memI32[headOff / 4];
      let tail = this.memI32[tailOff / 4];
      const slotIdx = head % ml.capacity;
      const slotPtr = ml.slotsOffset + slotIdx * ml.slotSize;
      // Drop-oldest if full
      if (head + 1 - tail >= ml.capacity) {
        this.memI32[overflowOff / 4] += 1;
        this.memI32[tailOff / 4] = tail + 1;
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
      this.memI32[headOff / 4] = head + 1;
    }

    _enqueueMidi(ev) {
      const inp = LAYOUT.midiInputs[0];
      if (!inp) return;
      const headOff = inp.headerOffset;
      const tailOff = inp.headerOffset + 4;
      const overflowOff = inp.headerOffset + 8;
      let head = this.memI32[headOff / 4];
      let tail = this.memI32[tailOff / 4];
      const slotIdx = head % inp.capacity;
      const slotPtr = inp.slotsOffset + slotIdx * 8;
      if (head + 1 - tail >= inp.capacity) {
        this.memI32[overflowOff / 4] += 1;
        this.memI32[tailOff / 4] = tail + 1;
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
      this.memI32[(slotPtr + 4) / 4] = (ev.atSample ?? 0) | 0;
      this.memI32[headOff / 4] = head + 1;
    }

    _drainOutboundEvents() {
      let any = false;
      const eventsOut = {};
      for (const ev of LAYOUT.events) {
        const headOff = ev.headerOffset;
        const tailOff = ev.headerOffset + 4;
        let head = this.memI32[headOff / 4];
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
      const headOff = out.headerOffset;
      let head = this.memI32[headOff / 4];
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
      // Run WASM process
      this.exports.process(block);
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
      return true;
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
