import {
  getCurrentRuntime,
  type StateRuntime,
  type BufferRuntime,
  type StateSlot,
  type BufferSlot,
  type ParamSlot,
  type AudioInputSlot,
  type AudioOutputSlot,
  type EventSlot,
  type MessageSlot,
  type MidiInputSlot,
  type MidiOutputSlot,
  type Scope,
} from "./runtime.js";
import { getCaptureBackend } from "./capture-backend.js";
import type {
  ScalarType,
  StateOptions,
  BufferOptions,
  ParamOptions,
  AudioInputOptions,
  AudioOutputOptions,
  EventOptions,
  MessageOptions,
  MidiOptions,
  State,
  Buffer,
  ParamHandle,
  AudioInputHandle,
  AudioOutputHandle,
  EventDecl,
  MessageDecl,
  MidiInputHandle,
  MidiOutputHandle,
  Node,
  ChannelIndex,
  MidiEvent,
  MidiEventByType,
} from "./types.js";

function makeStateRuntime(slot: StateSlot): StateRuntime {
  let storage: any;
  if (slot.type === "f32") storage = new Float32Array([slot.initial as number]);
  else if (slot.type === "f64") storage = new Float64Array([slot.initial as number]);
  else if (slot.type === "i32") storage = new Int32Array([slot.initial as number]);
  else if (slot.type === "i64") storage = new BigInt64Array([BigInt(slot.initial as number)]);
  else if (slot.type === "bool") storage = { value: slot.initial as boolean };
  else throw new Error(`Unknown state type: ${slot.type}`);
  return {
    slot,
    storage,
    read() {
      if (slot.type === "bool") return (storage as { value: boolean }).value;
      if (slot.type === "i64") return Number((storage as BigInt64Array)[0]);
      return (storage as Float32Array | Float64Array | Int32Array)[0]!;
    },
    write(v) {
      if (slot.type === "bool") {
        (storage as { value: boolean }).value = !!v;
      } else if (slot.type === "i64") {
        (storage as BigInt64Array)[0] = BigInt(Math.trunc(v as number));
      } else if (slot.type === "i32") {
        (storage as Int32Array)[0] = Math.trunc(v as number) | 0;
      } else {
        (storage as Float32Array | Float64Array)[0] = v as number;
      }
    },
  };
}

function makeBufferRuntime(slot: BufferSlot): BufferRuntime {
  let storage: Float32Array | Int32Array | Float64Array;
  if (slot.type === "f32") storage = new Float32Array(slot.size);
  else if (slot.type === "i32") storage = new Int32Array(slot.size);
  else if (slot.type === "f64") storage = new Float64Array(slot.size);
  else throw new Error(`Buffer type ${slot.type} not yet supported`);
  return { slot, storage };
}

function pathOf(scope: Scope, name?: string): string {
  if (!name) return scope.pathPrefix;
  return scope.pathPrefix + name;
}

function makeStateHandle<T extends ScalarType>(sr: StateRuntime, type: T, name?: string): State<T> {
  return {
    load: () => sr.read() as Node<T>,
    store: (v) => sr.write(v as number | boolean),
    __isState: true,
    __type: type,
    __name: name,
  };
}

function makeBufferHandle<T extends ScalarType>(br: BufferRuntime, type: T): Buffer<T> {
  const storage = br.storage;
  const size = br.slot.size;
  const slotType = br.slot.type;
  const read = (idx: number | Node<"i32">) => {
    let i = ((idx as number) | 0) % size;
    if (i < 0) i += size;
    return storage[i]! as Node<T>;
  };
  const write = (idx: number | Node<"i32">, v: number | Node<T>) => {
    let i = ((idx as number) | 0) % size;
    if (i < 0) i += size;
    storage[i] = v as number;
  };
  const readInterpolated = (pos: number | Node<"f32">) => {
    const p = pos as number;
    const ip0 = Math.floor(p);
    const f = p - ip0;
    let i0 = ip0 % size;
    if (i0 < 0) i0 += size;
    const i1 = (i0 + 1) % size;
    const a = storage[i0]! as number;
    const b = storage[i1]! as number;
    return (a + (b - a) * f) as unknown as Node<T>;
  };
  const loadVec = (offset: number | Node<"i32">) => {
    const o = (offset as number) | 0;
    if (slotType !== "f32") throw new Error("loadVec only supported for f32 buffers");
    const arr = storage as Float32Array;
    const out = new Float32Array(4);
    for (let k = 0; k < 4; k++) {
      let i = (o + k) % size;
      if (i < 0) i += size;
      out[k] = arr[i]!;
    }
    Object.defineProperty(out, "lane", {
      value: (i: 0 | 1 | 2 | 3) => out[i]! as Node<"f32">,
      enumerable: false,
      configurable: true,
    });
    return out as unknown as Node<"f32x4">;
  };
  const storeVec = (offset: number | Node<"i32">, value: Node<"f32x4">) => {
    const o = (offset as number) | 0;
    if (slotType !== "f32") throw new Error("storeVec only supported for f32 buffers");
    const arr = storage as Float32Array;
    const v = value as unknown as Float32Array;
    for (let k = 0; k < 4; k++) {
      let i = (o + k) % size;
      if (i < 0) i += size;
      arr[i] = v[k]!;
    }
  };
  return {
    read,
    write,
    readInterpolated,
    loadVec,
    storeVec,
    size,
    name: br.slot.name,
    __isBuffer: true,
    __type: type,
  };
}

function declareState<T extends ScalarType>(
  type: T,
  initial: number | boolean,
  options?: StateOptions<T>,
): State<T> {
  const rt = getCurrentRuntime();
  const scope = rt.currentScope();
  // Replay mode: scope already has a state at the current decl cursor.
  if (scope.fullyDeclared) {
    const idx = scope.declCursor.state++;
    const existing = scope.states[idx];
    if (!existing) {
      throw new Error(
        `State declaration mismatch: scope expected ${scope.states.length} states but body is requesting more.`,
      );
    }
    return makeStateHandle(existing, type, options?.name);
  }
  scope.declCursor.state++;
  const slot: StateSlot = {
    kind: "state",
    type,
    name: options?.name,
    initial,
    snapshot: options?.snapshot ?? "persistent",
    publish: options?.publish,
    path: pathOf(scope, options?.name),
  };
  const sr = makeStateRuntime(slot);
  scope.states.push(sr);
  return makeStateHandle(sr, type, options?.name);
}

export const state = {
  f32: (initial: number, options?: StateOptions<"f32">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.state.f32(initial, options);
    return declareState("f32", initial, options);
  },
  f64: (initial: number, options?: StateOptions<"f64">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.state.f64(initial, options);
    return declareState("f64", initial, options);
  },
  i32: (initial: number, options?: StateOptions<"i32">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.state.i32(initial, options);
    return declareState("i32", initial, options);
  },
  i64: (initial: number, options?: StateOptions<"i64">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.state.i64(initial, options);
    return declareState("i64", initial, options);
  },
  bool: (initial: boolean, options?: StateOptions<"bool">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.state.bool(initial, options);
    return declareState("bool", initial, options);
  },
};

function declareBuffer<T extends ScalarType>(type: T, options: BufferOptions<T>): Buffer<T> {
  const rt = getCurrentRuntime();
  const scope = rt.currentScope();
  if (scope.fullyDeclared) {
    const idx = scope.declCursor.buffer++;
    const existing = scope.buffers[idx];
    if (!existing) {
      throw new Error(
        `Buffer declaration mismatch: scope expected ${scope.buffers.length} buffers but body is requesting more.`,
      );
    }
    return makeBufferHandle(existing, type);
  }
  scope.declCursor.buffer++;
  const slot: BufferSlot = {
    kind: "buffer",
    type,
    name: options.name,
    size: options.size,
    snapshot: options.snapshot ?? "transient",
    publish: options.publish,
    path: pathOf(scope, options.name),
  };
  const br = makeBufferRuntime(slot);
  scope.buffers.push(br);
  return makeBufferHandle(br, type);
}

export const buffer = {
  f32: (options: BufferOptions<"f32">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.buffer.f32(options);
    return declareBuffer("f32", options);
  },
  f64: (options: BufferOptions<"f64">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.buffer.f64(options);
    return declareBuffer("f64", options);
  },
  i32: (options: BufferOptions<"i32">) => {
    const cap = getCaptureBackend();
    if (cap) return cap.buffer.i32(options);
    return declareBuffer("i32", options);
  },
};

export function param(options: ParamOptions): ParamHandle {
  const cap = getCaptureBackend();
  if (cap) return cap.param(options);
  const rt = getCurrentRuntime();
  // Params can only be declared at root setup time; subgraphs can also declare
  // them but we store them at processor level for AudioParam binding.
  const slot: ParamSlot = {
    kind: "param",
    name: options.name,
    default: options.default,
    min: options.min,
    max: options.max,
    automationRate: options.automationRate,
    unit: options.unit,
    snapshot: options.snapshot ?? "persistent",
  };
  const isARate = slot.automationRate === "a-rate";
  const valuesLen = isARate ? rt.currentBlockSize : 1;
  const values = new Float32Array(valuesLen);
  values.fill(options.default);
  const runtime = { slot, values, currentValue: options.default };
  rt.params.push({ slot, runtime });
  return {
    at: (i: Node<"i32"> | number) => {
      const idx = (i as number) | 0;
      if (isARate) {
        const safe = idx < 0 ? 0 : idx >= values.length ? values.length - 1 : idx;
        return values[safe]! as Node<"f32">;
      }
      return values[0]! as Node<"f32">;
    },
    __isParam: true,
    __name: slot.name,
  };
}

export function audioInput<C extends number>(options: AudioInputOptions<C>): AudioInputHandle<C> {
  const cap = getCaptureBackend();
  if (cap) return cap.audioInput(options) as any;
  return audioInputInterp(options);
}

function audioInputInterp<C extends number>(options: AudioInputOptions<C>): AudioInputHandle<C> {
  const rt = getCurrentRuntime();
  const slot: AudioInputSlot = {
    kind: "audioInput",
    name: options.name,
    channels: options.channels,
  };
  const channels: Float32Array[] = [];
  for (let c = 0; c < slot.channels; c++) {
    channels.push(new Float32Array(rt.currentBlockSize));
  }
  rt.audioInputs.push({ slot, runtime: { slot, channels } });
  return {
    at: (c: ChannelIndex<C>, i: Node<"i32"> | number) => {
      const ch = channels[c as number];
      if (!ch) return 0 as unknown as Node<"f32">;
      const idx = (i as number) | 0;
      if (idx < 0 || idx >= ch.length) return 0 as unknown as Node<"f32">;
      return ch[idx]! as Node<"f32">;
    },
    channels: options.channels,
    name: options.name,
    __isAudioInput: true,
  };
}

export function audioOutput<C extends number>(
  options: AudioOutputOptions<C>,
): AudioOutputHandle<C> {
  const cap = getCaptureBackend();
  if (cap) return cap.audioOutput(options) as any;
  return audioOutputInterp(options);
}

function audioOutputInterp<C extends number>(
  options: AudioOutputOptions<C>,
): AudioOutputHandle<C> {
  const rt = getCurrentRuntime();
  const slot: AudioOutputSlot = {
    kind: "audioOutput",
    name: options.name,
    channels: options.channels,
  };
  const channels: Float32Array[] = [];
  for (let c = 0; c < slot.channels; c++) {
    channels.push(new Float32Array(rt.currentBlockSize));
  }
  rt.audioOutputs.push({ slot, runtime: { slot, channels } });
  return {
    set: (c: ChannelIndex<C>, i: Node<"i32"> | number, v: Node<"f32"> | number) => {
      const ch = channels[c as number];
      if (!ch) return;
      const idx = (i as number) | 0;
      if (idx < 0 || idx >= ch.length) return;
      ch[idx] = v as number;
    },
    channels: options.channels,
    name: options.name,
    __isAudioOutput: true,
  };
}

export function event<T>(options: EventOptions): EventDecl<T> {
  const cap = getCaptureBackend();
  if (cap) return cap.event<T>(options);
  return eventInterp<T>(options);
}

function eventInterp<T>(options: EventOptions): EventDecl<T> {
  const rt = getCurrentRuntime();
  const slot: EventSlot = {
    kind: "event",
    name: options.name,
    capacity: options.capacity ?? 256,
  };
  rt.events.push({ slot, runtime: { slot } });
  rt.outboundEvents.set(options.name, []);
  rt.outboundEventOverflow.set(options.name, 0);
  return {
    emitIf: (cond: any, payload: any) => {
      if (cond) {
        const list = rt.outboundEvents.get(options.name)!;
        if (list.length >= slot.capacity) {
          list.shift();
          rt.outboundEventOverflow.set(
            options.name,
            (rt.outboundEventOverflow.get(options.name) ?? 0) + 1,
          );
        }
        const out = { ...payload };
        if ("atSample" in out) out.atSample = (out.atSample as number) | 0;
        list.push({ atSample: out.atSample ?? 0, payload: out });
      }
    },
    __isEvent: true,
    __name: options.name,
  };
}

export function message<T>(options: MessageOptions): MessageDecl<T> {
  const cap = getCaptureBackend();
  if (cap) return cap.message<T>(options);
  return messageInterp<T>(options);
}

function messageInterp<T>(options: MessageOptions): MessageDecl<T> {
  const rt = getCurrentRuntime();
  const slot: MessageSlot = {
    kind: "message",
    name: options.name,
    capacity: options.capacity ?? 256,
  };
  rt.messages.push({ slot, runtime: { slot } });
  return {
    onReceive: (handler: (payload: any) => void) => {
      const list = rt.messageHandlers.get(options.name) ?? [];
      list.push(handler);
      rt.messageHandlers.set(options.name, list);
    },
    __isMessage: true,
    __name: options.name,
  };
}

export function midiInput(options: MidiOptions = {}): MidiInputHandle {
  const cap = getCaptureBackend();
  if (cap) return cap.midiInput(options);
  return midiInputInterp(options);
}

function midiInputInterp(options: MidiOptions = {}): MidiInputHandle {
  const rt = getCurrentRuntime();
  const name = options.name ?? "midi";
  const slot: MidiInputSlot = {
    kind: "midiInput",
    name,
    capacity: options.capacity ?? 256,
  };
  rt.midiInputs.push({ slot, runtime: { slot } });
  rt.pendingMidiEvents.set(name, []);
  if (!rt.midiHandlers.has(name)) rt.midiHandlers.set(name, new Map());
  return {
    onEvent<K extends MidiEvent["type"]>(type: K, handler: (e: MidiEventByType<K>) => void) {
      const m = rt.midiHandlers.get(name)!;
      const list = m.get(type) ?? [];
      list.push(handler as any);
      m.set(type, list);
    },
    __isMidiInput: true,
    __name: name,
  };
}

export function midiOutput(options: MidiOptions = {}): MidiOutputHandle {
  const cap = getCaptureBackend();
  if (cap) return cap.midiOutput(options);
  return midiOutputInterp(options);
}

function midiOutputInterp(options: MidiOptions = {}): MidiOutputHandle {
  const rt = getCurrentRuntime();
  const name = options.name ?? "midiOut";
  const slot: MidiOutputSlot = {
    kind: "midiOutput",
    name,
    capacity: options.capacity ?? 256,
  };
  rt.midiOutputs.push({ slot, runtime: { slot } });
  return {
    emitIf(cond: any, ev: MidiEvent) {
      if (cond) {
        if (rt.outboundMidi.length >= slot.capacity) {
          rt.outboundMidi.shift();
          rt.outboundMidiOverflow++;
        }
        const e = { ...ev } as MidiEvent;
        (e as any).atSample = (e.atSample as number) | 0;
        rt.outboundMidi.push({ event: e });
      }
    },
    __isMidiOutput: true,
    __name: name,
  };
}
