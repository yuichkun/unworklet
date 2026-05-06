import { Engine } from "@unworklet/core/internal";
import type { CompiledProcessor, MidiEvent } from "@unworklet/core";
import { Lifecycle, type LifecycleState } from "./lifecycle.js";

export { Lifecycle, type LifecycleState, type LifecycleListener } from "./lifecycle.js";

export type CreateNodeOptions = {
  sampleRate?: number;
  blockSize?: number;
  initial?: Record<string, number>;
};

// In-Node / pure-JS UnworkletNode. In a browser environment this wraps a
// real AudioWorkletNode (use `@unworklet/worklet`'s `createWasmNode` for
// that path). The shape is the same; on the JS path `.node` is null.
export type UnworkletNode = {
  // Underlying AudioWorkletNode when the WASM transport is in use; null
  // for the pure-JS path (offline rendering / Node tests).
  node: AudioWorkletNode | null;
  inputs: Record<string, FakeAudioConnect>;
  outputs: Record<string, FakeAudioConnect>;
  params: Record<string, FakeAudioParam>;
  state: Record<string, StatePublisher>;
  events: Record<string, EventSubscription>;
  messages: Record<string, MessageSender>;
  midi: MidiAPI;
  diagnostics: { transport: "sab" | "postMessage" | "js" };
  // Lifecycle state machine — see docs/05-client §4 + lifecycle.ts.
  lifecycle: {
    readonly state: LifecycleState;
    onChange(handler: (state: LifecycleState) => void): () => void;
  };
  snapshot(options?: { profile?: string }): Promise<Uint8Array>;
  restore(blob: Uint8Array): Promise<{ restored: number; skipped: string[]; missing: string[] }>;
  // Decode a snapshot blob's slot summary without applying it.
  inspect(blob: Uint8Array): {
    version: number;
    schemaHash: string;
    profile?: string;
    slots: Record<string, { kind: string; type?: string; value?: any; bytes?: number }>;
  };
  dispose(): void;
  onError(handler: (err: Error) => void): void;
  __engine: Engine;
};

export type FakeAudioConnect = {
  connect(node: any): any;
  disconnect(): void;
  __name: string;
};

export type FakeAudioParam = {
  value: number;
  setValueAtTime(value: number, t: number): void;
  linearRampToValueAtTime(value: number, t: number): void;
  exponentialRampToValueAtTime(value: number, t: number): void;
  __name: string;
  __automation: AutomationPoint[];
  __engine: Engine;
};

type AutomationPoint =
  | { kind: "set"; t: number; value: number }
  | { kind: "linear"; t: number; value: number }
  | { kind: "exponential"; t: number; value: number };

export type StatePublisher = {
  readonly value: any;
  subscribe(handler: (v: any) => void): () => void;
};

export type EventSubscription = {
  on(handler: (payload: any) => void): () => void;
  diagnostics: { overflowCount(): number };
};

export type MessageSender = {
  (payload: any): void;
  diagnostics: { overflowCount(): number };
};

export type MidiAPI = {
  send(event: MidiEvent, atTime?: number): void;
  connectFromWebMIDI(input: any): void;
  onEvent<K extends MidiEvent["type"]>(
    type: K,
    handler: (e: Extract<MidiEvent, { type: K }>) => void,
  ): () => void;
};

export async function createNode(
  _audioContext: any,
  processor: CompiledProcessor,
  options: CreateNodeOptions = {},
): Promise<UnworkletNode> {
  const sampleRate = options.sampleRate ?? _audioContext?.sampleRate ?? 48000;
  const blockSize = options.blockSize ?? 128;
  const engine = new Engine(processor, { sampleRate, blockSize });

  // Apply initial param values
  if (options.initial) {
    for (const [name, value] of Object.entries(options.initial)) {
      const p = engine.rt.params.find((p) => p.slot.name === name);
      if (p) {
        p.runtime.currentValue = value;
        p.runtime.values.fill(value);
      }
    }
  }

  const inputs: Record<string, FakeAudioConnect> = {};
  for (const ai of engine.rt.audioInputs) {
    inputs[ai.slot.name] = { connect() {}, disconnect() {}, __name: ai.slot.name };
  }
  const outputs: Record<string, FakeAudioConnect> = {};
  for (const ao of engine.rt.audioOutputs) {
    outputs[ao.slot.name] = { connect() {}, disconnect() {}, __name: ao.slot.name };
  }
  const params: Record<string, FakeAudioParam> = {};
  for (const p of engine.rt.params) {
    const ap: FakeAudioParam = {
      get value() {
        return p.runtime.currentValue;
      },
      set value(v: number) {
        p.runtime.currentValue = v;
        p.runtime.values.fill(v);
      },
      setValueAtTime(value, t) {
        ap.__automation.push({ kind: "set", t, value });
      },
      linearRampToValueAtTime(value, t) {
        ap.__automation.push({ kind: "linear", t, value });
      },
      exponentialRampToValueAtTime(value, t) {
        ap.__automation.push({ kind: "exponential", t, value });
      },
      __name: p.slot.name,
      __automation: [],
      __engine: engine,
    };
    params[p.slot.name] = ap;
  }
  const state: Record<string, StatePublisher> = {};
  // For each published state and buffer slot, expose subscribe + value.
  const collectPublished = () => {
    for (const scope of engine.rt.allScopes) {
      for (const sr of scope.states) {
        if (!sr.slot.publish) continue;
        const path = sr.slot.path;
        const name = sr.slot.name ?? path;
        if (state[name]) continue;
        state[name] = {
          get value() {
            return engine.rt.publishLastValues.get(path) ?? sr.read();
          },
          subscribe(h) {
            const list = engine.rt.publishObservers.get(path) ?? [];
            list.push(h);
            engine.rt.publishObservers.set(path, list);
            return () => {
              const lst = engine.rt.publishObservers.get(path);
              if (lst) {
                const i = lst.indexOf(h);
                if (i >= 0) lst.splice(i, 1);
              }
            };
          },
        };
      }
      for (const br of scope.buffers) {
        if (!br.slot.publish) continue;
        const path = br.slot.path;
        const name = br.slot.name;
        if (state[name]) continue;
        state[name] = {
          get value() {
            return engine.rt.publishLastValues.get(path) ?? br.storage.slice();
          },
          subscribe(h) {
            const list = engine.rt.publishObservers.get(path) ?? [];
            list.push(h);
            engine.rt.publishObservers.set(path, list);
            return () => {
              const lst = engine.rt.publishObservers.get(path);
              if (lst) {
                const i = lst.indexOf(h);
                if (i >= 0) lst.splice(i, 1);
              }
            };
          },
        };
      }
    }
  };
  collectPublished();

  const events: Record<string, EventSubscription> = {};
  const eventListeners = new Map<string, Array<(p: any) => void>>();
  for (const e of engine.rt.events) {
    const name = e.slot.name;
    eventListeners.set(name, []);
    events[name] = {
      on(handler) {
        const list = eventListeners.get(name)!;
        list.push(handler);
        return () => {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      diagnostics: {
        overflowCount() {
          return engine.rt.outboundEventOverflow.get(name) ?? 0;
        },
      },
    };
  }

  const messages: Record<string, MessageSender> = {};
  for (const m of engine.rt.messages) {
    const name = m.slot.name;
    const fn = ((payload: any) => {
      engine.postMessage(name, payload);
    }) as MessageSender;
    fn.diagnostics = {
      overflowCount: () => engine.rt.pendingMessageOverflow.get(name) ?? 0,
    };
    messages[name] = fn;
  }

  const midiInputName = engine.rt.midiInputs[0]?.slot.name;
  const midiOutputName = engine.rt.midiOutputs[0]?.slot.name;
  const midiOutListeners = new Map<string, Array<(e: any) => void>>();

  const midi: MidiAPI = {
    send(event, atTime) {
      if (!midiInputName) return;
      // atTime is a host-time offset in seconds (per docs/05-client + 11-midi).
      // The JS Engine schedules per-block; convert atTime → atSample on the
      // event's atSample field. If atTime omitted, queue at sample 0 of the
      // next block (existing behaviour).
      const sr = engine.rt.sampleRate;
      const augmented: any = atTime !== undefined
        ? { ...event, atSample: Math.max(0, Math.round((atTime as number) * sr)) }
        : event;
      engine.postMidiEvent(midiInputName, augmented);
    },
    connectFromWebMIDI(input: any) {
      if (!midiInputName) return;
      // input is a Web MIDI MIDIInput. Subscribe to its onmidimessage.
      if (input && typeof input.addEventListener === "function") {
        input.addEventListener("midimessage", (msg: any) => {
          const ev = parseMidiBytes(msg.data);
          if (ev) engine.postMidiEvent(midiInputName, ev);
        });
      } else if (input) {
        input.onmidimessage = (msg: any) => {
          const ev = parseMidiBytes(msg.data);
          if (ev) engine.postMidiEvent(midiInputName, ev);
        };
      }
    },
    onEvent(type, handler) {
      const list = midiOutListeners.get(type) ?? [];
      list.push(handler);
      midiOutListeners.set(type, list);
      return () => {
        const lst = midiOutListeners.get(type);
        if (lst) {
          const i = lst.indexOf(handler);
          if (i >= 0) lst.splice(i, 1);
        }
      };
    },
  };

  const errorHandlers: Array<(err: Error) => void> = [];
  const lifecycle = new Lifecycle();
  // The JS-engine path skips the load step (everything is in-process), so
  // we transition straight to ready.
  lifecycle.transition("ready");

  const node: UnworkletNode = {
    node: null,
    inputs,
    outputs,
    params,
    state,
    events,
    messages,
    midi,
    diagnostics: { transport: "js" },
    lifecycle: {
      get state() {
        return lifecycle.state;
      },
      onChange(handler) {
        return lifecycle.on((s) => handler(s));
      },
    },
    async snapshot(opts) {
      if (lifecycle.state === "creating" || lifecycle.state === "ready") {
        lifecycle.transition("running");
      }
      return engine.snapshot(opts?.profile);
    },
    async restore(blob) {
      return engine.restore(blob);
    },
    inspect(blob) {
      return inspect(blob);
    },
    dispose() {
      lifecycle.transition("disposed");
    },
    onError(h) {
      errorHandlers.push(h);
    },
    __engine: engine,
  };

  // After each block, dispatch outbound events to listeners
  // We'll attach a hook on engine: wrap render() externally, OR consumers will call
  // dispatch helpers themselves. For renderOffline, the render() returns events
  // and the caller wires them.
  return node;
}

// Public renderOffline entry point.
export type RenderOfflineConfig = {
  sampleRate?: number;
  duration: number;
  blockSize?: number;
  params?: Record<string, number>;
  paramAutomation?: Record<string, (t: number) => number>;
  input?: Record<string, ((sampleOffset: number, channel: number) => number) | Float32Array[]>;
  messages?: Array<{ at?: number; name: string; payload: any }>;
  midiEvents?: Array<{ at?: number; event: MidiEvent }>;
};

export type RenderOfflineResult = {
  output: Record<string, Float32Array[]>;
  events: Array<{ at: number; name: string; payload: any }>;
  midiOut: Array<{ at: number; event: MidiEvent }>;
  peak: number;
  rms: number;
  hasNaN: boolean;
};

export async function renderOffline(
  processor: CompiledProcessor,
  config: RenderOfflineConfig,
): Promise<RenderOfflineResult> {
  const sampleRate = config.sampleRate ?? 48000;
  const blockSize = config.blockSize ?? 128;
  const totalSamples = Math.ceil(config.duration * sampleRate);
  const numBlocks = Math.ceil(totalSamples / blockSize);

  const engine = new Engine(processor, { sampleRate, blockSize });

  // Apply initial param values
  if (config.params) {
    for (const [name, value] of Object.entries(config.params)) {
      const p = engine.rt.params.find((p) => p.slot.name === name);
      if (p) {
        p.runtime.currentValue = value;
        p.runtime.values.fill(value);
      }
    }
  }

  // Allocate output collections
  const outputs: Record<string, Float32Array[]> = {};
  for (const ao of engine.rt.audioOutputs) {
    outputs[ao.slot.name] = [];
    for (let c = 0; c < ao.slot.channels; c++) {
      outputs[ao.slot.name]!.push(new Float32Array(totalSamples));
    }
  }

  const eventsOut: Array<{ at: number; name: string; payload: any }> = [];
  const midiOut: Array<{ at: number; event: MidiEvent }> = [];

  // Pre-bucket messages and MIDI by block
  const messagesByBlock = new Map<number, Array<{ name: string; payload: any }>>();
  for (const m of config.messages ?? []) {
    const t = m.at ?? 0;
    const blockIdx = Math.max(0, Math.floor((t * sampleRate) / blockSize));
    const list = messagesByBlock.get(blockIdx) ?? [];
    list.push({ name: m.name, payload: m.payload });
    messagesByBlock.set(blockIdx, list);
  }
  const midiByBlock = new Map<number, Array<MidiEvent>>();
  for (const m of config.midiEvents ?? []) {
    const t = m.at ?? 0;
    const absoluteSample = Math.max(0, Math.floor(t * sampleRate));
    const blockIdx = Math.floor(absoluteSample / blockSize);
    const atSample = absoluteSample - blockIdx * blockSize;
    const e = { ...m.event, atSample } as MidiEvent;
    const list = midiByBlock.get(blockIdx) ?? [];
    list.push(e);
    midiByBlock.set(blockIdx, list);
  }

  // For the input function, pre-allocate per-block buffers
  const inputBuffers: Record<string, Float32Array[]> = {};
  for (const ai of engine.rt.audioInputs) {
    inputBuffers[ai.slot.name] = [];
    for (let c = 0; c < ai.slot.channels; c++) {
      inputBuffers[ai.slot.name]!.push(new Float32Array(blockSize));
    }
  }

  // Param automation per-block
  const paramAutoArrays: Record<string, Float32Array | number> = {};

  let peak = 0;
  let sumSq = 0;
  let totalSamplesProcessed = 0;
  let hasNaN = false;

  for (let b = 0; b < numBlocks; b++) {
    const blockSampleStart = b * blockSize;

    // Fill inputs
    for (const ai of engine.rt.audioInputs) {
      const name = ai.slot.name;
      const inSrc = config.input?.[name];
      const bufs = inputBuffers[name]!;
      if (Array.isArray(inSrc)) {
        for (let c = 0; c < bufs.length; c++) {
          const data = inSrc[c];
          const buf = bufs[c]!;
          if (data) {
            for (let i = 0; i < blockSize; i++) {
              const s = blockSampleStart + i;
              buf[i] = s < data.length ? data[s]! : 0;
            }
          } else {
            buf.fill(0);
          }
        }
      } else if (typeof inSrc === "function") {
        for (let c = 0; c < bufs.length; c++) {
          const buf = bufs[c]!;
          for (let i = 0; i < blockSize; i++) {
            buf[i] = inSrc(blockSampleStart + i, c);
          }
        }
      } else {
        for (const buf of bufs) buf.fill(0);
      }
    }

    // Param automation
    if (config.paramAutomation) {
      for (const [name, fn] of Object.entries(config.paramAutomation)) {
        const p = engine.rt.params.find((p) => p.slot.name === name);
        if (!p) continue;
        const isARate = p.slot.automationRate === "a-rate";
        if (isARate) {
          const arr = new Float32Array(blockSize);
          for (let i = 0; i < blockSize; i++) {
            const s = blockSampleStart + i;
            arr[i] = fn(s / sampleRate);
          }
          paramAutoArrays[name] = arr;
        } else {
          paramAutoArrays[name] = fn(blockSampleStart / sampleRate);
        }
      }
    }

    // Inject messages and MIDI
    const ms = messagesByBlock.get(b);
    if (ms) for (const m of ms) engine.postMessage(m.name, m.payload);
    const mids = midiByBlock.get(b);
    if (mids) {
      const inputName = engine.rt.midiInputs[0]?.slot.name;
      if (inputName) for (const ev of mids) engine.postMidiEvent(inputName, ev);
    }

    // Render block
    const result = engine.render(inputBuffers, paramAutoArrays);

    // Copy outputs
    for (const ao of engine.rt.audioOutputs) {
      const dst = outputs[ao.slot.name]!;
      const src = result.outputs[ao.slot.name]!;
      for (let c = 0; c < src.length; c++) {
        const s = src[c]!;
        const d = dst[c]!;
        const len = Math.min(blockSize, totalSamples - blockSampleStart);
        for (let i = 0; i < len; i++) {
          const v = s[i]!;
          d[blockSampleStart + i] = v;
          if (Number.isNaN(v)) hasNaN = true;
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sumSq += v * v;
          totalSamplesProcessed++;
        }
      }
    }
    // Collect events with absolute sample timestamp
    for (const [name, list] of result.events) {
      for (const ev of list) {
        eventsOut.push({
          at: (blockSampleStart + ev.atSample) / sampleRate,
          name,
          payload: ev.payload,
        });
      }
    }
    for (const ev of result.midiOut) {
      midiOut.push({ at: (blockSampleStart + ev.atSample) / sampleRate, event: ev });
    }
  }

  return {
    output: outputs,
    events: eventsOut,
    midiOut,
    peak,
    rms: totalSamplesProcessed > 0 ? Math.sqrt(sumSq / totalSamplesProcessed) : 0,
    hasNaN,
  };
}

export function inspect(blob: Uint8Array): {
  version: number;
  schemaHash: string;
  profile: string | null;
  slots: Record<string, any>;
  format?: "engine" | "wasm";
} {
  // Detect WASM-side UWSN snapshot format and surface its metadata. The
  // WASM blob doesn't carry slot-keyed payloads (only state-region bytes
  // + buffer table), so `slots` will be empty for those — but at least
  // version + schemaHash come through, which is what most callers want.
  if (
    blob.length >= 12 &&
    blob[0] === 0x55 && blob[1] === 0x57 && blob[2] === 0x53 && blob[3] === 0x4e
  ) {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const version = dv.getUint32(4, true);
    const hashLen = dv.getUint32(8, true);
    let h = "";
    for (let i = 0; i < hashLen; i++) h += String.fromCharCode(blob[12 + i]!);
    return { version, schemaHash: h, profile: null, slots: {}, format: "wasm" };
  }
  // Standalone inspect — doesn't need an engine; we re-use the format.
  const dec = new TextDecoder();
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let off = 0;
  const magic = String.fromCharCode(...blob.subarray(0, 4));
  if (magic !== "UWS1") throw new Error("Invalid snapshot blob magic");
  off = 4;
  const hashLen = view.getUint8(off);
  off += 1;
  const schemaHash = dec.decode(blob.subarray(off, off + hashLen));
  off += hashLen;
  const profileLen = view.getUint8(off);
  off += 1;
  const profile = profileLen === 0 ? null : dec.decode(blob.subarray(off, off + profileLen));
  off += profileLen;
  const numSlots = view.getUint32(off, true);
  off += 4;
  const slots: Record<string, any> = {};
  for (let i = 0; i < numSlots; i++) {
    const kind = view.getUint8(off);
    off += 1;
    const pathLen = view.getUint16(off, true);
    off += 2;
    const path = dec.decode(blob.subarray(off, off + pathLen));
    off += pathLen;
    const len = view.getUint32(off, true);
    off += 4;
    const data = blob.subarray(off, off + len);
    off += len;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (kind === 0) slots[path] = { kind: "state", type: "f32", value: dv.getFloat32(0, true) };
    else if (kind === 1)
      slots[path] = { kind: "state", type: "f64", value: dv.getFloat64(0, true) };
    else if (kind === 2) slots[path] = { kind: "state", type: "i32", value: dv.getInt32(0, true) };
    else if (kind === 3)
      slots[path] = { kind: "state", type: "i64", value: Number(dv.getBigInt64(0, true)) };
    else if (kind === 4) slots[path] = { kind: "state", type: "bool", value: dv.getUint8(0) !== 0 };
    else if (kind === 10) {
      const arr = new Float32Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
      slots[path] = {
        kind: "buffer",
        type: "f32",
        length: arr.length,
        head: Array.from(arr.subarray(0, Math.min(64, arr.length))),
      };
    } else if (kind === 12) {
      const arr = new Int32Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
      slots[path] = {
        kind: "buffer",
        type: "i32",
        length: arr.length,
        head: Array.from(arr.subarray(0, Math.min(64, arr.length))),
      };
    } else if (kind === 20) slots[path] = { kind: "param", value: dv.getFloat64(0, true) };
  }
  return { version: 1, schemaHash, profile, slots, format: "engine" };
}

function parseMidiBytes(data: Uint8Array): MidiEvent | null {
  if (data.length < 1) return null;
  const status = data[0]!;
  const high = status & 0xf0;
  const channel = status & 0x0f;
  const atSample = 0;
  if (high === 0x90) {
    const note = data[1] ?? 0;
    const velocity = data[2] ?? 0;
    if (velocity === 0) return { type: "noteOff", channel, note, velocity, atSample };
    return { type: "noteOn", channel, note, velocity, atSample };
  }
  if (high === 0x80) {
    return { type: "noteOff", channel, note: data[1] ?? 0, velocity: data[2] ?? 0, atSample };
  }
  if (high === 0xb0) {
    return { type: "cc", channel, controller: data[1] ?? 0, value: data[2] ?? 0, atSample };
  }
  if (high === 0xe0) {
    const lsb = data[1] ?? 0;
    const msb = data[2] ?? 0;
    return { type: "pitchBend", channel, value: (msb << 7) | lsb, atSample };
  }
  if (high === 0xc0) {
    return { type: "programChange", channel, program: data[1] ?? 0, atSample };
  }
  if (high === 0xd0) {
    return { type: "channelPressure", channel, pressure: data[1] ?? 0, atSample };
  }
  if (high === 0xa0) {
    return { type: "aftertouch", channel, note: data[1] ?? 0, pressure: data[2] ?? 0, atSample };
  }
  if (status >= 0xf8 && status <= 0xfc) {
    return { type: "systemRealtime", status, atSample };
  }
  return null;
}
