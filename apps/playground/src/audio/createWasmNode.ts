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
  diagnostics: { transport: "wasm-worklet" };
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
  type Ready = { type: "ready"; layout: any; paramDescs: any[] };
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
  // Messages senders
  const messages: WasmUnworkletNode["messages"] = {};
  for (const m of layout.messages) {
    messages[m.name] = (payload: any) => {
      node.port.postMessage({ type: "message", name: m.name, payload });
    };
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

  // State publishing not yet implemented in the WASM worklet — placeholder.
  const state: WasmUnworkletNode["state"] = {};

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
    }
  });

  return {
    node,
    inputs,
    outputs,
    params,
    state,
    events,
    messages,
    midi,
    diagnostics: { transport: "wasm-worklet" },
    dispose() {
      try {
        node.disconnect();
      } catch {}
      try {
        node.port.close();
      } catch {}
    },
  };
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
