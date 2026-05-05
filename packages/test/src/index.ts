// @unworklet/test — Vitest/Jest-friendly offline rendering for processors.
//
// Per docs/06-testing.md and draft_spec §9.1, every processor can be tested
// without a browser by rendering against the pure-JS interpreter (default)
// or the WASM backend (cross-validation).

export {
  renderOffline,
  type RenderOfflineConfig,
  type RenderOfflineResult,
  inspect,
  createNode,
} from "@unworklet/client";

import {
  compileToWasm,
  type CompileResult,
} from "@unworklet/compiler";
import type { CompiledProcessor, MidiEvent } from "@unworklet/core";

export type RenderOfflineWasmConfig = {
  sampleRate?: number;
  duration: number;
  blockSize?: number;
  params?: Record<string, number>;
  paramAutomation?: Record<string, (t: number) => number>;
  input?: Record<string, ((sampleOffset: number, channel: number) => number) | Float32Array[]>;
  messages?: Array<{ at?: number; name: string; payload: any }>;
  midiEvents?: Array<{ at?: number; event: MidiEvent }>;
};

export type RenderOfflineWasmResult = {
  output: Record<string, Float32Array[]>;
  events: Array<{ at: number; name: string; payload: any }>;
  midiOut: Array<{ at: number; event: MidiEvent }>;
  peak: number;
  rms: number;
  hasNaN: boolean;
};

export async function renderOfflineWasm(
  processor: CompiledProcessor,
  config: RenderOfflineWasmConfig,
): Promise<RenderOfflineWasmResult> {
  const sampleRate = config.sampleRate ?? 48000;
  const blockSize = config.blockSize ?? 128;
  const totalSamples = Math.ceil(config.duration * sampleRate);
  const numBlocks = Math.ceil(totalSamples / blockSize);
  const compileResult = compileToWasm(processor, { sampleRate, renderQuantum: blockSize });
  const mod = await WebAssembly.compile(compileResult.binary as any);
  const inst = await WebAssembly.instantiate(mod, {
    math: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
    },
  });
  const exports = inst.exports as any;
  exports.init();
  const memBuf = (exports.memory as WebAssembly.Memory).buffer;
  const mem = new Float32Array(memBuf);
  const memU8 = new Uint8Array(memBuf);
  const memI32 = new Int32Array(memBuf);

  const layout = compileResult.layout;
  const graph = compileResult.graph;

  // Pre-bucket messages and MIDI by block index
  const messagesByBlock = new Map<number, Array<{ name: string; payload: any }>>();
  for (const m of config.messages ?? []) {
    const t = m.at ?? 0;
    const b = Math.max(0, Math.floor((t * sampleRate) / blockSize));
    const list = messagesByBlock.get(b) ?? [];
    list.push({ name: m.name, payload: m.payload });
    messagesByBlock.set(b, list);
  }
  const midiByBlock = new Map<number, Array<MidiEvent>>();
  for (const m of config.midiEvents ?? []) {
    const t = m.at ?? 0;
    const absSample = Math.max(0, Math.floor(t * sampleRate));
    const b = Math.floor(absSample / blockSize);
    const atSample = absSample - b * blockSize;
    const ev = { ...m.event, atSample } as MidiEvent;
    const list = midiByBlock.get(b) ?? [];
    list.push(ev);
    midiByBlock.set(b, list);
  }

  // Track read heads for outbound events / MIDI so we don't double-drain.
  const eventReadHeads = new Map<string, number>();
  const midiOutReadHead = new Map<string, number>();

  function enqueueMessage(name: string, payload: any) {
    const ml = layout.messages.layouts.find((m) => {
      const decl = graph.declarations.messages.find((x) => x.id === m.messageId)!;
      return decl.name === name;
    });
    if (!ml) return;
    const decl = graph.declarations.messages.find((x) => x.id === ml.messageId)!;
    const headOff = ml.headerOffset;
    const tailOff = ml.headerOffset + 4;
    const overflowOff = ml.headerOffset + 8;
    const head = memI32[headOff >> 2]!;
    const tail = memI32[tailOff >> 2]!;
    const slotIdx = head % ml.capacity;
    const slotPtr = ml.slotsOffset + slotIdx * ml.slotSize;
    if (head + 1 - tail >= ml.capacity) {
      memI32[overflowOff >> 2]! += 1;
      memI32[tailOff >> 2] = tail + 1;
    }
    for (const f of decl.fields) {
      const off = ml.fieldOffsets[f.name];
      if (!off) continue;
      const v = payload?.[f.name];
      if (typeof v !== "number" && typeof v !== "boolean") continue;
      if (off.type === "f32") mem[(slotPtr + off.offset) >> 2] = +v;
      else if (off.type === "i32" || off.type === "bool") memI32[(slotPtr + off.offset) >> 2] = (v as any) | 0;
    }
    memI32[headOff >> 2] = head + 1;
  }

  function enqueueMidi(ev: MidiEvent) {
    const inp = layout.midiInputs.layouts[0];
    if (!inp) return;
    const headOff = inp.headerOffset;
    const tailOff = inp.headerOffset + 4;
    const overflowOff = inp.headerOffset + 8;
    const head = memI32[headOff >> 2]!;
    const tail = memI32[tailOff >> 2]!;
    const slotIdx = head % inp.capacity;
    const slotPtr = inp.slotsOffset + slotIdx * 8;
    if (head + 1 - tail >= inp.capacity) {
      memI32[overflowOff >> 2]! += 1;
      memI32[tailOff >> 2] = tail + 1;
    }
    let status = 0, data1 = 0, data2 = 0;
    const ch = ((ev as any).channel ?? 0) & 0x0f;
    switch (ev.type) {
      case "noteOn":  status = 0x90 | ch; data1 = ev.note; data2 = ev.velocity; break;
      case "noteOff": status = 0x80 | ch; data1 = ev.note; data2 = ev.velocity; break;
      case "cc":      status = 0xb0 | ch; data1 = ev.controller; data2 = ev.value; break;
      case "pitchBend": status = 0xe0 | ch; data1 = ev.value & 0x7f; data2 = (ev.value >> 7) & 0x7f; break;
      case "programChange": status = 0xc0 | ch; data1 = ev.program; break;
      case "channelPressure": status = 0xd0 | ch; data1 = ev.pressure; break;
      case "aftertouch": status = 0xa0 | ch; data1 = ev.note; data2 = ev.pressure; break;
      case "systemRealtime": status = ev.status; break;
    }
    memU8[slotPtr] = status & 0xff;
    memU8[slotPtr + 1] = data1 & 0xff;
    memU8[slotPtr + 2] = data2 & 0xff;
    memU8[slotPtr + 3] = 0;
    memI32[(slotPtr + 4) >> 2] = (ev.atSample ?? 0) | 0;
    memI32[headOff >> 2] = head + 1;
  }

  function drainOutboundEvents(blockStart: number, out: Array<{ at: number; name: string; payload: any }>) {
    for (const el of layout.events.layouts) {
      const decl = graph.declarations.events.find((e) => e.id === el.eventId)!;
      const head = memI32[el.headerOffset >> 2]!;
      const last = eventReadHeads.get(decl.name) ?? 0;
      if (head === last) continue;
      for (let n = last; n < head; n++) {
        const slotIdx = n % el.capacity;
        const slotPtr = el.slotsOffset + slotIdx * el.slotSize;
        const atSample = memI32[slotPtr >> 2]!;
        const payload: any = {};
        for (const f of decl.fields) {
          const off = el.fieldOffsets[f.name];
          if (!off) continue;
          if (f.type === "f32") payload[f.name] = mem[(slotPtr + off.offset) >> 2];
          else if (f.type === "i32" || f.type === "bool") payload[f.name] = memI32[(slotPtr + off.offset) >> 2];
        }
        out.push({ at: (blockStart + atSample) / sampleRate, name: decl.name, payload: { atSample, ...payload } });
      }
      eventReadHeads.set(decl.name, head);
    }
  }

  function drainOutboundMidi(blockStart: number, out: Array<{ at: number; event: MidiEvent }>) {
    for (const ml of layout.midiOutputs.layouts) {
      const decl = graph.declarations.midiOutputs.find((m) => m.id === ml.midiId)!;
      const head = memI32[ml.headerOffset >> 2]!;
      const last = midiOutReadHead.get(decl.name) ?? 0;
      if (head === last) continue;
      for (let n = last; n < head; n++) {
        const slotIdx = n % ml.capacity;
        const slotPtr = ml.slotsOffset + slotIdx * 8;
        const status = memU8[slotPtr]!;
        const data1 = memU8[slotPtr + 1]!;
        const data2 = memU8[slotPtr + 2]!;
        const atSample = memI32[(slotPtr + 4) >> 2]!;
        const high = status & 0xf0;
        const channel = status & 0x0f;
        let ev: MidiEvent | null = null;
        if (high === 0x90) ev = data2 === 0
          ? { type: "noteOff", channel, note: data1, velocity: 0, atSample }
          : { type: "noteOn", channel, note: data1, velocity: data2, atSample };
        else if (high === 0x80) ev = { type: "noteOff", channel, note: data1, velocity: data2, atSample };
        else if (high === 0xb0) ev = { type: "cc", channel, controller: data1, value: data2, atSample };
        else if (high === 0xe0) ev = { type: "pitchBend", channel, value: (data2 << 7) | data1, atSample };
        else if (high === 0xc0) ev = { type: "programChange", channel, program: data1, atSample };
        else if (high === 0xd0) ev = { type: "channelPressure", channel, pressure: data1, atSample };
        else if (high === 0xa0) ev = { type: "aftertouch", channel, note: data1, pressure: data2, atSample };
        else if (status >= 0xf8 && status <= 0xfc) ev = { type: "systemRealtime", status, atSample };
        if (ev) out.push({ at: (blockStart + atSample) / sampleRate, event: ev });
      }
      midiOutReadHead.set(decl.name, head);
    }
  }

  const padded = numBlocks * blockSize;
  const outputs: Record<string, Float32Array[]> = {};
  for (const ao of layout.audioOutputs.outputs) {
    const decl = graph.declarations.audioOutputs.find((a) => a.id === ao.outputId)!;
    outputs[decl.name] = Array.from({ length: ao.channels }, () => new Float32Array(padded));
  }
  const eventsOut: Array<{ at: number; name: string; payload: any }> = [];
  const midiOutEvents: Array<{ at: number; event: MidiEvent }> = [];

  let peak = 0, sumSq = 0, n = 0, hasNaN = false;
  for (let b = 0; b < numBlocks; b++) {
    const blockStart = b * blockSize;

    // Inject pending messages and MIDI for this block (BEFORE process)
    const ms = messagesByBlock.get(b);
    if (ms) for (const m of ms) enqueueMessage(m.name, m.payload);
    const mids = midiByBlock.get(b);
    if (mids) for (const ev of mids) enqueueMidi(ev);

    // Marshal inputs
    for (const ai of layout.audioInputs.inputs) {
      const decl = graph.declarations.audioInputs.find((a) => a.id === ai.inputId)!;
      const inSrc = config.input?.[decl.name];
      for (let c = 0; c < ai.channels; c++) {
        const start = (ai.offset + c * ai.channelStride) >> 2;
        const dst = mem.subarray(start, start + blockSize);
        if (Array.isArray(inSrc)) {
          const ch = inSrc[c];
          if (ch) for (let i = 0; i < blockSize; i++) {
            const s = blockStart + i;
            dst[i] = s < ch.length ? ch[s]! : 0;
          } else {
            dst.fill(0);
          }
        } else if (typeof inSrc === "function") {
          for (let i = 0; i < blockSize; i++) dst[i] = inSrc(blockStart + i, c);
        } else {
          dst.fill(0);
        }
      }
    }
    // Marshal params
    for (const pl of layout.params.layouts) {
      const decl = graph.declarations.params.find((p) => p.id === pl.paramId)!;
      const v =
        config.paramAutomation?.[decl.name]?.(blockStart / sampleRate) ??
        config.params?.[decl.name] ??
        decl.default;
      if (pl.automationRate === "a-rate") {
        for (let i = 0; i < blockSize; i++) mem[(pl.offset >> 2) + i] = v;
      } else {
        mem[pl.offset >> 2] = v;
      }
    }
    exports.process(blockSize);
    // Read outputs
    for (const ao of layout.audioOutputs.outputs) {
      const decl = graph.declarations.audioOutputs.find((a) => a.id === ao.outputId)!;
      for (let c = 0; c < ao.channels; c++) {
        const start = (ao.offset + c * ao.channelStride) >> 2;
        const src = mem.subarray(start, start + blockSize);
        outputs[decl.name]![c]!.set(src, blockStart);
        for (let i = 0; i < blockSize; i++) {
          const v = src[i]!;
          if (Number.isNaN(v)) hasNaN = true;
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sumSq += v * v;
          n++;
        }
      }
    }
    // Drain outbound events and MIDI
    drainOutboundEvents(blockStart, eventsOut);
    drainOutboundMidi(blockStart, midiOutEvents);
  }
  // Trim padded outputs to totalSamples
  for (const k of Object.keys(outputs)) {
    outputs[k] = outputs[k]!.map((c) => c.slice(0, totalSamples));
  }
  return {
    output: outputs,
    events: eventsOut,
    midiOut: midiOutEvents,
    peak,
    rms: n > 0 ? Math.sqrt(sumSq / n) : 0,
    hasNaN,
  };
}
