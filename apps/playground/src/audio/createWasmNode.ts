// Compile a CompiledProcessor to WASM via @unworklet/compiler, then load
// the generated worklet module via Blob URL and instantiate the AudioWorkletNode.
//
// This is the production audio path: the user's processor body is captured
// at compile time, lowered to a binaryen-emitted WASM binary, and run in the
// AudioWorklet thread with no per-block JS execution.

import { compileToWasm, generateWorkletModule } from "@unworklet/compiler";
import type { CompiledProcessor, MidiEvent } from "@unworklet/core";

const moduleUrlCache = new WeakMap<CompiledProcessor, string>();
const moduleAddedFor = new WeakMap<BaseAudioContext, Set<CompiledProcessor>>();

export type CreateWasmNodeOptions = {
  sampleRate?: number;
  blockSize?: number;
};

import { Lifecycle, type LifecycleState } from "@unworklet/client";

export type WasmUnworkletNode = {
  node: AudioWorkletNode;
  inputs: Record<string, { connect: (n: AudioNode) => void; disconnect: () => void; node: AudioWorkletNode; index: number }>;
  outputs: Record<string, { connect: (n: AudioNode) => void; disconnect: () => void; node: AudioWorkletNode; index: number }>;
  params: Record<string, AudioParam>;
  state: Record<string, { readonly value: any; subscribe(h: (v: any) => void): () => void }>;
  events: Record<string, { on(h: (p: any) => void): () => void; diagnostics: { overflowCount(): number } }>;
  messages: Record<string, (payload: any) => void>;
  midi: {
    send(ev: MidiEvent): void;
    onEvent<K extends MidiEvent["type"]>(type: K, h: (e: Extract<MidiEvent, { type: K }>) => void): () => void;
    connectFromWebMIDI(input: any): void;
  };
  diagnostics: {
    transport: "audio-worklet" | "sab" | "postMessage";
    overflows(): { events: Record<string, number>; messages: Record<string, number> };
  };
  lifecycle: {
    state: LifecycleState;
    onChange(h: (s: LifecycleState) => void): () => void;
  };
  snapshot(opts?: { profile?: string }): Promise<Uint8Array>;
  restore(blob: Uint8Array): Promise<{ restored: number; skipped: string[]; missing: string[]; error?: string }>;
  dispose(): void;
};

export async function createWasmNode(
  audioContext: BaseAudioContext,
  processor: CompiledProcessor,
  processorName: string,
  _options: CreateWasmNodeOptions = {},
): Promise<WasmUnworkletNode> {
  // Compile (cached per processor reference).
  let url = moduleUrlCache.get(processor);
  if (!url) {
    const result = compileToWasm(processor, { sampleRate: audioContext.sampleRate });
    const source = generateWorkletModule(result.graph, result.layout, result.binary, {
      processorName,
    });
    const blob = new Blob([source], { type: "application/javascript" });
    url = URL.createObjectURL(blob);
    moduleUrlCache.set(processor, url);
  }

  // addModule only once per context per processor.
  let addedSet = moduleAddedFor.get(audioContext);
  if (!addedSet) {
    addedSet = new Set();
    moduleAddedFor.set(audioContext, addedSet);
  }
  if (!addedSet.has(processor)) {
    await audioContext.audioWorklet.addModule(url);
    addedSet.add(processor);
  }

  // Construct the AudioWorkletNode. We don't yet know the I/O shape, so use
  // a generous default. The worklet posts its layout via a 'ready' message.
  const node = new AudioWorkletNode(audioContext, `uw:${processorName}`, {
    numberOfInputs: 4,
    numberOfOutputs: 4,
    outputChannelCount: [2, 2, 2, 2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });

  // Wait for 'ready' to learn layout
  type Ready = {
    type: "ready";
    layout: any;
    paramDescs: any[];
    memory: SharedArrayBuffer | null;
    transport: "sab" | "postMessage";
  };
  const ready = await new Promise<Ready>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "ready") {
        node.port.removeEventListener("message", onMessage);
        resolve(e.data as Ready);
      }
    };
    node.port.addEventListener("message", onMessage);
    node.port.start();
    setTimeout(() => reject(new Error("wasm-worklet ready timeout")), 5000);
  });

  const layout = ready.layout;
  const sharedMem = ready.memory;
  const memU8 = sharedMem ? new Uint8Array(sharedMem) : null;
  const memI32 = sharedMem ? new Int32Array(sharedMem) : null;
  const memF32 = sharedMem ? new Float32Array(sharedMem) : null;

  // Build .inputs / .outputs / .params surfaces
  const inputs: WasmUnworkletNode["inputs"] = {};
  const outputs: WasmUnworkletNode["outputs"] = {};
  for (let i = 0; i < layout.audioInputs.length; i++) {
    const ai = layout.audioInputs[i];
    // We don't have the name in layout summary — use index as fallback.
    // The graph's audioInputs is indexed by id which equals position.
    const name = `__in_${i}`;
    inputs[name] = {
      connect: (n: AudioNode) => n.connect(node, 0, i),
      disconnect: () => {},
      node,
      index: i,
    };
  }
  for (let i = 0; i < layout.audioOutputs.length; i++) {
    const ao = layout.audioOutputs[i];
    const name = `__out_${i}`;
    outputs[name] = {
      connect: (n: AudioNode) => node.connect(n, i, 0),
      disconnect: () => {},
      node,
      index: i,
    };
  }
  // Replace fallback names with declared names by re-compiling and reading the
  // graph; we cached the result so do it again here.
  const compiled = compileToWasm(processor, { sampleRate: audioContext.sampleRate });
  const inputNames = compiled.graph.declarations.audioInputs.map((a) => a.name);
  const outputNames = compiled.graph.declarations.audioOutputs.map((a) => a.name);
  for (let i = 0; i < inputNames.length; i++) {
    const k = inputNames[i]!;
    inputs[k] = inputs[`__in_${i}`]!;
  }
  for (let i = 0; i < outputNames.length; i++) {
    const k = outputNames[i]!;
    outputs[k] = outputs[`__out_${i}`]!;
  }

  // Params via real AudioParams
  const params: Record<string, AudioParam> = {};
  for (const desc of ready.paramDescs) {
    const ap = (node.parameters as Map<string, AudioParam>).get(desc.name);
    if (ap) params[desc.name] = ap;
  }

  // Outbound events / midi listeners
  const eventListeners = new Map<string, Array<(p: any) => void>>();
  const events: WasmUnworkletNode["events"] = {};
  for (const ev of layout.events) {
    eventListeners.set(ev.name, []);
    events[ev.name] = {
      on(handler) {
        const list = eventListeners.get(ev.name)!;
        list.push(handler);
        return () => {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      diagnostics: { overflowCount: () => 0 },
    };
  }
  // Messages senders. When SAB transport is available, write the slot
  // directly into the shared linear memory + Atomics-bump the ring head;
  // otherwise fall back to postMessage which the worklet enqueues.
  const messages: WasmUnworkletNode["messages"] = {};
  for (const m of layout.messages) {
    if (sharedMem && memI32 && memU8 && memF32) {
      const ml = m;
      messages[m.name] = (payload: any) => {
        try {
          enqueueSAB(ml, payload, memI32, memU8, memF32);
        } catch (e) {
          // Fall back to postMessage if anything goes wrong.
          node.port.postMessage({ type: "message", name: ml.name, payload });
        }
      };
    } else {
      messages[m.name] = (payload: any) => {
        node.port.postMessage({ type: "message", name: m.name, payload });
      };
    }
  }
  // MIDI
  const midiOutListeners = new Map<string, Array<(e: any) => void>>();
  const midi: WasmUnworkletNode["midi"] = {
    send(ev) {
      node.port.postMessage({ type: "midi", event: ev });
    },
    onEvent(type, handler) {
      const list = midiOutListeners.get(type) ?? [];
      list.push(handler as any);
      midiOutListeners.set(type, list);
      return () => {
        const lst = midiOutListeners.get(type);
        if (lst) {
          const i = lst.indexOf(handler as any);
          if (i >= 0) lst.splice(i, 1);
        }
      };
    },
    connectFromWebMIDI(input) {
      if (!input) return;
      input.onmidimessage = (msg: any) => {
        const ev = parseMidiBytes(msg.data);
        if (ev) midi.send(ev);
      };
    },
  };

  // State publishing — drain comes via `publish` messages from the worklet.
  const stateLast = new Map<string, any>();
  const stateSubs = new Map<string, Array<(v: any) => void>>();
  const state: WasmUnworkletNode["state"] = {};
  const allPublished = [
    ...((layout.publishedStates ?? []) as Array<{ path: string; name?: string }>),
    ...((layout.publishedBuffers ?? []) as Array<{ path: string; name?: string }>),
  ];
  for (const pl of allPublished) {
    const key = pl.name ?? pl.path;
    stateSubs.set(pl.path, []);
    state[key] = {
      get value() {
        return stateLast.get(pl.path);
      },
      subscribe(handler) {
        const list = stateSubs.get(pl.path)!;
        list.push(handler);
        return () => {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
    };
  }

  // Lifecycle
  const lifecycle = new Lifecycle();
  lifecycle.transition("ready");

  // Snapshot/restore plumbing
  let nextRpcId = 1;
  const pending = new Map<number, (v: any) => void>();
  const eventOverflow = new Map<string, number>();
  const messageOverflow = new Map<string, number>();
  const errorListeners: Array<(e: any) => void> = [];

  node.port.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === "events") {
      for (const [name, list] of Object.entries(msg.events ?? {})) {
        const subs = eventListeners.get(name);
        if (!subs) continue;
        for (const item of list as any[]) {
          for (const h of subs) {
            try {
              h(item);
            } catch (e) {
              console.error(e);
            }
          }
        }
      }
    } else if (msg.type === "midi-out") {
      for (const item of msg.events ?? []) {
        const handlers = midiOutListeners.get(item.event.type) ?? [];
        for (const h of handlers) {
          try {
            h(item.event);
          } catch (e) {
            console.error(e);
          }
        }
      }
    } else if (msg.type === "publish") {
      for (const [path, value] of Object.entries(msg.values ?? {})) {
        stateLast.set(path, value);
        const subs = stateSubs.get(path);
        if (subs) for (const h of subs) {
          try { h(value); } catch (err) { console.error(err); }
        }
      }
      if (lifecycle.state === "ready") lifecycle.transition("running");
    } else if (msg.type === "overflow") {
      // Worklet reports an overflow on a queue; track per-name counts.
      if (msg.kind === "event") eventOverflow.set(msg.name, (eventOverflow.get(msg.name) ?? 0) + 1);
      else if (msg.kind === "message") messageOverflow.set(msg.name, (messageOverflow.get(msg.name) ?? 0) + 1);
    } else if (msg.type === "error") {
      lifecycle.transition("errored");
      for (const h of errorListeners) try { h(msg); } catch {}
    } else if (msg.type === "snapshot-response" || msg.type === "restore-response") {
      const cb = pending.get(msg.id);
      if (cb) {
        pending.delete(msg.id);
        cb(msg.type === "snapshot-response" ? msg.blob : msg.result);
      }
    }
  });

  // Patch event diagnostics overflowCount to read the real counter.
  for (const ev of layout.events) {
    events[ev.name].diagnostics = {
      overflowCount: () => eventOverflow.get(ev.name) ?? 0,
    };
  }

  return {
    node,
    inputs,
    outputs,
    params,
    state,
    events,
    messages,
    midi,
    diagnostics: {
      transport: ready.transport,
      overflows: () => ({
        events: Object.fromEntries(eventOverflow),
        messages: Object.fromEntries(messageOverflow),
      }),
    },
    lifecycle: {
      get state() {
        return lifecycle.state;
      },
      onChange(h) {
        return lifecycle.on((s) => h(s));
      },
    },
    async snapshot(opts) {
      const id = nextRpcId++;
      const p = new Promise<Uint8Array>((resolve) => pending.set(id, resolve));
      node.port.postMessage({ type: "snapshot", id, profile: opts?.profile });
      return p;
    },
    async restore(blob) {
      const id = nextRpcId++;
      const p = new Promise<{ restored: number; skipped: string[]; missing: string[]; error?: string }>(
        (resolve) => pending.set(id, resolve),
      );
      // Apply migrations on the host side if the blob's hash differs from
      // the worklet's current schemaHash. We use a transient JS Engine to
      // walk the migration chain, then convert the resulting state into a
      // WASM-format blob the worklet can apply.
      let toSend = blob;
      const wasmHash = layout.schemaHash;
      if (wasmHash && getSnapshotHash(blob) && getSnapshotHash(blob) !== wasmHash) {
        try {
          toSend = await migrateForWasm(processor, blob, layout) ?? blob;
        } catch (err) {
          console.warn("[unworklet] migration failed:", err);
        }
      }
      node.port.postMessage({ type: "restore", id, blob: toSend }, [toSend.buffer]);
      return p;
    },
    dispose() {
      lifecycle.transition("disposed");
      try {
        node.disconnect();
      } catch {}
      try {
        node.port.close();
      } catch {}
    },
  };
}

// Read the schemaHash out of either WASM-format (UWSN) or Engine-format
// snapshot blobs. Returns null if the blob is unrecognized.
function getSnapshotHash(blob: Uint8Array): string | null {
  if (blob.length < 12) return null;
  if (
    blob[0] === 0x55 &&
    blob[1] === 0x57 &&
    blob[2] === 0x53 &&
    blob[3] === 0x4e
  ) {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const hashLen = dv.getUint32(8, true);
    let h = "";
    for (let i = 0; i < hashLen; i++) h += String.fromCharCode(blob[12 + i]!);
    return h;
  }
  // Engine-format: u32 version | u32 hashLen | <hash> | ...
  try {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const hashLen = dv.getUint32(4, true);
    let h = "";
    for (let i = 0; i < hashLen; i++) h += String.fromCharCode(blob[8 + i]!);
    return h;
  } catch {
    return null;
  }
}

// Apply migrations on the host using a transient JS Engine, then re-encode
// the resulting state into a WASM-format blob the worklet can ingest.
async function migrateForWasm(
  processor: any,
  blob: Uint8Array,
  layout: any,
): Promise<Uint8Array | null> {
  const core = await import("@unworklet/core/internal");
  const eng = new (core as any).Engine(processor, { sampleRate: 48000, blockSize: 128 });
  const result = eng.restore(blob);
  if (!result || result.error) return null;
  // Now serialize the engine's current state into WASM-format.
  const stateRegion = layout.stateRegion;
  const bufferRegion = layout.bufferRegion;
  const persistentBufs = bufferRegion.buffers.filter((b: any) => b.snapshot === "persistent");
  const stateBytes = stateRegion.size | 0;
  const bufBytes = persistentBufs.reduce((s: number, b: any) => s + b.byteSize, 0);
  const hashStr: string = layout.schemaHash;
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
  // Walk engine's runtime state slots; map each into the WASM state region.
  const stateView = new Uint8Array(out.buffer, p, stateBytes);
  for (const slot of stateRegion.slots) {
    const sr = (eng.rt.allScopes ?? []).flatMap((s: any) => s.states).find(
      (s: any) => s.slot.path === slot.path,
    );
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
    const br = (eng.rt.allScopes ?? []).flatMap((s: any) => s.buffers).find(
      (x: any) => x.slot.path === b.path,
    );
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

// SAB-transport message enqueue. Mirrors the worklet's own _enqueueMessage
// shape: scalar fields go into the slot, typed-array payloads go into the
// per-slot content area. Head bump uses Atomics.add to publish the slot to
// the audio thread.
function enqueueSAB(
  ml: any,
  payload: any,
  memI32: Int32Array,
  memU8: Uint8Array,
  memF32: Float32Array,
) {
  const headIdx = ml.headerOffset >> 2;
  const tailIdx = (ml.headerOffset + 4) >> 2;
  const overflowIdx = (ml.headerOffset + 8) >> 2;
  const head = Atomics.load(memI32, headIdx);
  const tail = Atomics.load(memI32, tailIdx);
  const slotIdx = ((head % ml.capacity) + ml.capacity) % ml.capacity;
  const slotPtr = ml.slotsOffset + slotIdx * ml.slotSize;
  if (head + 1 - tail >= ml.capacity) {
    Atomics.add(memI32, overflowIdx, 1);
    Atomics.store(memI32, tailIdx, tail + 1);
  }
  for (const f of ml.fields ?? []) {
    const off = ml.fieldOffsets?.[f.name];
    if (!off) continue;
    const v = payload?.[f.name];
    if (typeof v !== "number" && typeof v !== "boolean") continue;
    if (off.type === "f32") memF32[(slotPtr + off.offset) >> 2] = +v;
    else if (off.type === "i32" || off.type === "bool") memI32[(slotPtr + off.offset) >> 2] = (v as any) | 0;
  }
  for (const pf of ml.payloadFields ?? []) {
    const arr = payload?.[pf.name];
    const fieldBase = ml.payloadBufferOffset + slotIdx * ml.payloadStridePerSlot + pf.fieldOffsetWithinPayload;
    memI32[(slotPtr + pf.slotOffsetField) >> 2] = fieldBase;
    if (
      arr instanceof Float32Array ||
      arr instanceof Int32Array ||
      arr instanceof Uint8Array
    ) {
      const len = Math.min((arr as any).length, pf.maxLength);
      memI32[(slotPtr + pf.slotLengthField) >> 2] = len;
      if (pf.elemType === "f32") memF32.set((arr as Float32Array).subarray(0, len), fieldBase >> 2);
      else if (pf.elemType === "i32") memI32.set((arr as Int32Array).subarray(0, len), fieldBase >> 2);
      else memU8.set((arr as Uint8Array).subarray(0, len), fieldBase);
    } else {
      memI32[(slotPtr + pf.slotLengthField) >> 2] = 0;
    }
  }
  // Publish the slot.
  Atomics.add(memI32, headIdx, 1);
}

function parseMidiBytes(data: Uint8Array): MidiEvent | null {
  if (!data || data.length < 1) return null;
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
  if (high === 0x80) return { type: "noteOff", channel, note: data[1] ?? 0, velocity: data[2] ?? 0, atSample };
  if (high === 0xb0) return { type: "cc", channel, controller: data[1] ?? 0, value: data[2] ?? 0, atSample };
  if (high === 0xe0)
    return { type: "pitchBend", channel, value: ((data[2] ?? 0) << 7) | (data[1] ?? 0), atSample };
  if (high === 0xc0) return { type: "programChange", channel, program: data[1] ?? 0, atSample };
  if (high === 0xd0) return { type: "channelPressure", channel, pressure: data[1] ?? 0, atSample };
  if (high === 0xa0) return { type: "aftertouch", channel, note: data[1] ?? 0, pressure: data[2] ?? 0, atSample };
  if (status >= 0xf8 && status <= 0xfc) return { type: "systemRealtime", status, atSample };
  return null;
}
