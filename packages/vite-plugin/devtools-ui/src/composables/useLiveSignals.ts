/**
 * Live signals X-ray. Reads the `unworklet:signals` shared state the plugin
 * server mirrors from the dev page-script's AnalyserNode taps: per output port a
 * live time-domain scope, a normalized spectrum, and RMS/peak levels, plus each
 * node's declared linear-memory layout and the AudioContext's reported latencies.
 *
 * Per-frame data (scope / spectrum / levels) arrives ~30×/s, so it is kept in a
 * plain (non-reactive) Map that the canvas render loops read directly — only the
 * panel *structure* (which nodes / ports exist, their memory, the context) is
 * reactive, and it is reassigned solely when that structure changes. This keeps
 * Vue from re-rendering the whole panel on every audio frame.
 */

import type {} from "@vitejs/devtools-kit"; // makes the bare module augmentable below
import { getDevToolsRpcClient } from "@vitejs/devtools-kit/client";
import { DEVTOOLS_MOUNT_PATH } from "@vitejs/devtools-kit/constants";
import { computed, onMounted, shallowRef } from "vue";

export type LiveSignalsPort = {
  name: string;
  /** Downsampled time-domain scope, samples in [-1, 1]. */
  time: number[];
  /** Normalized spectrum bins in [0, 1]. */
  freq: number[];
  rms: number;
  peak: number;
};
export type LiveSignalsMemoryEntry = { name: string; kind: string; bytes: number };
export type LiveSignalsNode = {
  id: string;
  displayName: string;
  ports: LiveSignalsPort[];
  memory: LiveSignalsMemoryEntry[];
  memoryBytes: number;
};
export type LiveSignalsContext = {
  sampleRate: number;
  baseLatencyMs: number;
  outputLatencyMs: number;
};
export type LiveSignals = { nodes: LiveSignalsNode[]; context: LiveSignalsContext };

/** Panel-layout slice of a node (no per-frame arrays — those live in `frames`). */
export type SignalsNodeShape = {
  id: string;
  displayName: string;
  ports: string[];
  memory: LiveSignalsMemoryEntry[];
  memoryBytes: number;
};
export type SignalsStructure = { nodes: SignalsNodeShape[]; context: LiveSignalsContext };

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "unworklet:signals": LiveSignals;
  }
}

const EMPTY_CONTEXT: LiveSignalsContext = { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 };

/**
 * Coerce a (possibly partial / empty / version-skewed) payload into a
 * well-formed {@link LiveSignals}. Missing nodes / ports / arrays collapse to
 * empty so the render loops and templates never read `undefined`.
 */
export function normalizeSignals(s: LiveSignals | undefined): LiveSignals {
  return {
    nodes: (s?.nodes ?? []).map((n) => ({
      id: n.id,
      displayName: n.displayName,
      ports: (n.ports ?? []).map((p) => ({
        name: p.name,
        time: p.time ?? [],
        freq: p.freq ?? [],
        rms: p.rms ?? 0,
        peak: p.peak ?? 0,
      })),
      memory: n.memory ?? [],
      memoryBytes: n.memoryBytes ?? 0,
    })),
    context: s?.context ?? EMPTY_CONTEXT,
  };
}

/** Cheap structural signature — changes only when the panel layout must change. */
export function structureSignature(s: LiveSignals): string {
  const c = s.context;
  return (
    s.nodes
      .map((n) => `${n.id}:${n.ports.map((p) => p.name).join(",")}:${n.memoryBytes}`)
      .join("|") +
    `#${Math.round(c.baseLatencyMs)},${Math.round(c.outputLatencyMs)},${c.sampleRate}`
  );
}

const frameKey = (nodeId: string, portName: string): string => `${nodeId}::${portName}`;

// ── module-level singleton (one RPC subscription shared by every consumer) ──
const frames = new Map<string, LiveSignalsPort>();
const structure = shallowRef<SignalsStructure>({ nodes: [], context: EMPTY_CONTEXT });
let lastSig = "";
let started = false;

const apply = (raw: LiveSignals | undefined): void => {
  const s = normalizeSignals(raw);
  for (const n of s.nodes) {
    for (const p of n.ports) frames.set(frameKey(n.id, p.name), p);
  }
  const sig = structureSignature(s);
  if (sig !== lastSig) {
    lastSig = sig;
    structure.value = {
      nodes: s.nodes.map((n) => ({
        id: n.id,
        displayName: n.displayName,
        ports: n.ports.map((p) => p.name),
        memory: n.memory,
        memoryBytes: n.memoryBytes,
      })),
      context: s.context,
    };
  }
};

const ensureStarted = (): void => {
  if (started) return;
  started = true;
  // The dock panel runs in an iframe; open its own RPC channel to the backend
  // (mirrors useLiveState — the host only seeds the client context on the top page).
  const connect = async (): Promise<void> => {
    const rpc = await getDevToolsRpcClient({ baseURL: DEVTOOLS_MOUNT_PATH });
    const shared = await rpc.sharedState.get("unworklet:signals");
    apply(shared.value() as LiveSignals | undefined);
    shared.on("updated", (s) => apply(s as LiveSignals));
  };
  void connect().catch(() => {
    // Dev-only panel; nothing to show if the backend is unreachable.
    started = false;
  });
};

export function useLiveSignals() {
  onMounted(ensureStarted);
  /** Latest per-frame data for a port, read directly by canvas rAF loops. */
  const getFrame = (nodeId: string, portName: string): LiveSignalsPort | undefined =>
    frames.get(frameKey(nodeId, portName));
  return {
    nodes: computed(() => structure.value.nodes),
    context: computed(() => structure.value.context),
    getFrame,
  };
}
