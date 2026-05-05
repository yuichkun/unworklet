// Browser-side wrapper that mirrors the @unworklet/client UnworkletNode
// surface but is backed by a real AudioWorkletNode running our worklet bundle.

import type { MidiEvent } from "@unworklet/core";

type ReadyMessage = {
  type: "ready";
  ioShape: { inputs: Array<{ name: string; channels: number }>; outputs: Array<{ name: string; channels: number }> };
  paramDescs: Array<{ name: string; defaultValue: number; minValue: number; maxValue: number; automationRate: "a-rate" | "k-rate" }>;
  params: Array<{ name: string; default: number; min: number; max: number; automationRate: "a-rate" | "k-rate" }>;
  publishedSlots: Array<{ kind: "state" | "buffer"; path: string; name?: string; type?: string; size?: number }>;
  events: string[];
  messages: string[];
  midiInputs: string[];
  midiOutputs: string[];
};

let workletLoadedFor: WeakSet<BaseAudioContext> = new WeakSet();

export type BrowserNodeOptions = {
  workletUrl?: string;
};

export type BrowserUnworkletNode = {
  node: AudioWorkletNode;
  inputs: Record<string, { connect: (n: AudioNode) => void; disconnect: () => void; node: AudioWorkletNode; index: number }>;
  outputs: Record<string, { connect: (n: AudioNode) => void; disconnect: () => void; node: AudioWorkletNode; index: number }>;
  params: Record<string, AudioParam>;
  state: Record<string, { value: any; subscribe(h: (v: any) => void): () => void }>;
  events: Record<string, { on(h: (p: any) => void): () => void; diagnostics: { overflowCount(): number } }>;
  messages: Record<string, (payload: any) => void>;
  midi: {
    send(ev: MidiEvent): void;
    onEvent<K extends MidiEvent["type"]>(type: K, h: (e: Extract<MidiEvent, { type: K }>) => void): () => void;
    connectFromWebMIDI(input: any): void;
  };
  diagnostics: { transport: "audio-worklet" };
  snapshot(opts?: { profile?: string }): Promise<Uint8Array>;
  restore(blob: Uint8Array): Promise<{ restored: number; skipped: string[]; missing: string[] }>;
  dispose(): void;
  meta: ReadyMessage;
};

export async function createBrowserNode(
  audioContext: BaseAudioContext,
  processorName: string,
  options: BrowserNodeOptions = {},
): Promise<BrowserUnworkletNode> {
  const url = options.workletUrl ?? "/unworklet-worklet.js";
  if (!workletLoadedFor.has(audioContext)) {
    try {
      await audioContext.audioWorklet.addModule(url);
      console.log("[unworklet] worklet module loaded:", url);
    } catch (e: any) {
      console.error("[unworklet] addModule failed:", e?.message ?? e, e);
      throw e;
    }
    workletLoadedFor.add(audioContext);
  }

  // We don't yet know the I/O shape — construct with safe defaults; the
  // worklet will report actual I/O via its 'ready' message.
  // We probe via a one-shot fetch + parse: not feasible because we'd need to
  // execute the bundle on main. Instead we instantiate with a guessed shape
  // and rely on the worklet's parameterDescriptors to populate AudioParams.
  //
  // We allow up to 4 inputs / 4 outputs by default — actual port wiring
  // is exposed via .inputs/.outputs once the ready message arrives.
  const node = new AudioWorkletNode(audioContext, `uw:${processorName}`, {
    numberOfInputs: 4,
    numberOfOutputs: 4,
    outputChannelCount: [2, 2, 2, 2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });

  // Wait for ready
  const meta: ReadyMessage = await new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "ready") {
        node.port.removeEventListener("message", onMessage);
        resolve(e.data as ReadyMessage);
      }
    };
    node.port.addEventListener("message", onMessage);
    node.port.start();
    setTimeout(() => reject(new Error("worklet ready timeout")), 5000);
  });

  // Inputs / outputs by declared name
  const inputs: BrowserUnworkletNode["inputs"] = {};
  meta.ioShape.inputs.forEach((p, i) => {
    inputs[p.name] = {
      connect: (n: AudioNode) => n.connect(node, 0, i),
      disconnect: () => {
        try {
          // No standard way to selectively disconnect input by index; advise the
          // user to disconnect at the source side. Provide a noop-disconnect.
        } catch {}
      },
      node,
      index: i,
    };
  });
  const outputs: BrowserUnworkletNode["outputs"] = {};
  meta.ioShape.outputs.forEach((p, i) => {
    outputs[p.name] = {
      connect: (n: AudioNode) => node.connect(n, i, 0),
      disconnect: () => node.disconnect(n_undefined as any, i),
      node,
      index: i,
    };
  });

  // Params
  const params: Record<string, AudioParam> = {};
  for (const p of meta.params) {
    const ap = (node.parameters as Map<string, AudioParam>).get(p.name);
    if (ap) params[p.name] = ap;
  }

  // Published state subscriptions
  const subscribers = new Map<string, Array<(v: any) => void>>();
  const lastValues = new Map<string, any>();
  for (const slot of meta.publishedSlots) {
    subscribers.set(slot.path, []);
  }
  const state: BrowserUnworkletNode["state"] = {};
  for (const slot of meta.publishedSlots) {
    const key = slot.name ?? slot.path;
    state[key] = {
      get value() {
        return lastValues.get(slot.path);
      },
      subscribe(handler: (v: any) => void) {
        const list = subscribers.get(slot.path)!;
        list.push(handler);
        return () => {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
    };
  }

  // Events
  const eventListeners = new Map<string, Array<(p: any) => void>>();
  const eventOverflow = new Map<string, number>();
  const events: BrowserUnworkletNode["events"] = {};
  for (const name of meta.events) {
    eventListeners.set(name, []);
    eventOverflow.set(name, 0);
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
        overflowCount: () => eventOverflow.get(name) ?? 0,
      },
    };
  }

  // Messages
  const messages: BrowserUnworkletNode["messages"] = {};
  for (const name of meta.messages) {
    messages[name] = (payload: any) => {
      // Try to transfer typed array payloads
      const transfer: ArrayBuffer[] = [];
      const visit = (v: any) => {
        if (
          v instanceof Float32Array ||
          v instanceof Int32Array ||
          v instanceof Uint8Array ||
          v instanceof Float64Array
        ) {
          // We can't transfer because the engine reads it on the worklet side
          // as a non-detached typed array; structured-clone copies it.
        }
      };
      node.port.postMessage({ type: "message", name, payload });
    };
  }

  // MIDI
  const midiOutListeners = new Map<string, Array<(e: any) => void>>();
  const midi: BrowserUnworkletNode["midi"] = {
    send(ev: MidiEvent) {
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
    connectFromWebMIDI(input: any) {
      if (!input) return;
      input.onmidimessage = (msg: any) => {
        const ev = parseMidiBytes(msg.data);
        if (ev) midi.send(ev);
      };
    },
  };

  // Snapshot/restore
  let nextId = 1;
  const pending = new Map<number, (v: any) => void>();

  // Listen to all messages from worklet
  node.port.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "events":
        for (const [name, list] of Object.entries(msg.events ?? {})) {
          const subs = eventListeners.get(name);
          if (!subs) continue;
          for (const item of list as Array<{ atSample: number; payload: any }>) {
            for (const h of subs) {
              try {
                h(item.payload);
              } catch (err) {
                console.error(err);
              }
            }
          }
        }
        break;
      case "midi-out":
        for (const item of msg.events ?? []) {
          const handlers = midiOutListeners.get(item.event.type) ?? [];
          for (const h of handlers) {
            try {
              h(item.event);
            } catch (err) {
              console.error(err);
            }
          }
        }
        break;
      case "publish":
        for (const [path, value] of Object.entries(msg.values ?? {})) {
          lastValues.set(path, value);
          const subs = subscribers.get(path);
          if (subs) for (const h of subs) h(value);
        }
        break;
      case "snapshot-response":
      case "restore-response": {
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg.type === "snapshot-response" ? msg.blob : msg.result);
        }
        break;
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
    diagnostics: { transport: "audio-worklet" },
    async snapshot(opts) {
      const id = nextId++;
      const p = new Promise<Uint8Array>((resolve) => pending.set(id, resolve));
      node.port.postMessage({ type: "snapshot", id, profile: opts?.profile });
      return p;
    },
    async restore(blob) {
      const id = nextId++;
      const p = new Promise<{ restored: number; skipped: string[]; missing: string[] }>(
        (resolve) => pending.set(id, resolve),
      );
      node.port.postMessage({ type: "restore", id, blob });
      return p;
    },
    dispose() {
      try {
        node.disconnect();
      } catch {}
      try {
        node.port.close();
      } catch {}
    },
    meta,
  };
}

const n_undefined: undefined = undefined;

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
