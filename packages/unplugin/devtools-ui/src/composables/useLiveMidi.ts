/**
 * Live MIDI panel. Reads the `unworklet:midi` shared state the plugin server
 * mirrors from the dev page-script: every declared MIDI port (with its real
 * overflow counter) plus a rolling log of real outbound events and panel
 * injections. Injection calls the `unworklet:midi-inject` RPC, which the
 * page-script drains into the real `node.midi[port].send` — the virtual keyboard
 * plays the actual worklet.
 *
 * Only `out` (worklet → main) and `inject` (panel → worklet) directions exist:
 * a worklet's inbound traffic isn't observable from the main thread, since the
 * main thread is the one sending it.
 */

import type {} from "@vitejs/devtools-kit"; // makes the bare module augmentable below
import { getPanelRpc, type PanelRpc } from "../lib/rpc";
import { computed, onMounted, ref } from "vue";

export type MidiEvent =
  | { type: "noteOn"; channel: number; note: number; velocity: number }
  | { type: "noteOff"; channel: number; note: number; velocity: number }
  | { type: "cc"; channel: number; controller: number; value: number }
  | { type: "pitchBend"; channel: number; value: number }
  | { type: "programChange"; channel: number; program: number }
  | { type: "channelPressure"; channel: number; pressure: number }
  | { type: "aftertouch"; channel: number; note: number; pressure: number }
  | { type: "systemRealtime"; status: number }
  | { type: "sysex"; data: number[] };

/** What the inject controls hand us (a subset of MidiEvent the keyboard emits). */
export type MidiEventInput = Extract<
  MidiEvent,
  { type: "noteOn" | "noteOff" | "cc" | "pitchBend" | "programChange" | "channelPressure" }
>;

export type MidiPortKind = "input" | "output";
export type MidiPortMeta = { nodeId: string; portName: string; kind: MidiPortKind };

export const portKey = (p: MidiPortMeta): string => `${p.nodeId}.${p.portName}`;

/**
 * Choose which input port the inject keyboard targets. The live port list arrives
 * asynchronously (the RPC connects after mount), so the panel re-runs this on every
 * port-list change: keep the current target while it still exists, otherwise fall
 * back to the first available port (and to "" when there are none).
 */
export const pickInputTarget = (ports: readonly MidiPortMeta[], current: string): string => {
  if (current && ports.some((p) => portKey(p) === current)) return current;
  return ports[0] ? portKey(ports[0]) : "";
};

export type MidiLogEntry = {
  id: number;
  ts: number;
  portKey: string;
  direction: "out" | "inject";
  event: MidiEvent;
};

type RawMidiPort = {
  nodeId: string;
  node: string;
  name: string;
  direction: "in" | "out";
  overflow: number;
};
type RawMidiLog = {
  seq: number;
  ts: number;
  dir: "out" | "inject";
  nodeId: string;
  port: string;
  event: MidiEvent;
};
export type MidiShared = { ports: RawMidiPort[]; log: RawMidiLog[] };

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "unworklet:midi": MidiShared;
  }
  interface DevToolsRpcServerFunctions {
    "unworklet:midi-inject": (cmd: { nodeId: string; port: string; event: MidiEvent }) => void;
  }
}

/** Coerce a (possibly empty / partial) payload into well-formed arrays. */
export function normalizeMidi(s: MidiShared | undefined): MidiShared {
  return { ports: s?.ports ?? [], log: s?.log ?? [] };
}

/** Project the raw ports into panel port metadata (in → input, out → output). */
export function mapPorts(s: MidiShared): MidiPortMeta[] {
  return s.ports.map((p) => ({
    nodeId: p.nodeId,
    portName: p.name,
    kind: p.direction === "in" ? "input" : "output",
  }));
}

/** Per-port real overflow counts, keyed by `nodeId.portName`. */
export function mapOverflow(s: MidiShared): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of s.ports) out[`${p.nodeId}.${p.name}`] = p.overflow;
  return out;
}

/** Project the raw log into panel entries, newest first. */
export function mapLog(s: MidiShared): MidiLogEntry[] {
  return s.log
    .map((e) => ({
      id: e.seq,
      ts: e.ts,
      portKey: `${e.nodeId}.${e.port}`,
      direction: e.dir,
      event: e.event,
    }))
    .reverse();
}

// ── module-level singleton (one RPC subscription shared by every consumer) ──
const shared = ref<MidiShared>({ ports: [], log: [] });
let rpcClient: PanelRpc | null = null;
let started = false;

const ensureStarted = (): void => {
  if (started) return;
  started = true;
  const connect = async (): Promise<void> => {
    const rpc = await getPanelRpc();
    rpcClient = rpc;
    const s = await rpc.sharedState.get("unworklet:midi");
    shared.value = normalizeMidi(s.value() as MidiShared | undefined);
    s.on("updated", (next) => {
      shared.value = normalizeMidi(next as MidiShared);
    });
  };
  void connect().catch(() => {
    started = false;
  });
};

export function useLiveMidi() {
  onMounted(ensureStarted);

  const ports = computed<MidiPortMeta[]>(() => mapPorts(shared.value));
  const overflow = computed<Record<string, number>>(() => mapOverflow(shared.value));
  const log = computed<MidiLogEntry[]>(() => mapLog(shared.value));

  const portByKey = computed<Record<string, RawMidiPort>>(() => {
    const out: Record<string, RawMidiPort> = {};
    for (const p of shared.value.ports) out[`${p.nodeId}.${p.name}`] = p;
    return out;
  });

  /** Send an event into a real input port via the inject RPC. */
  const injectMidi = (targetPortKey: string, event: MidiEventInput): void => {
    const meta = portByKey.value[targetPortKey];
    if (!meta || !rpcClient) return;
    void rpcClient.call("unworklet:midi-inject", {
      nodeId: meta.nodeId,
      port: meta.name,
      event,
    });
  };

  return { ports, portKey, log, overflow, injectMidi };
}
