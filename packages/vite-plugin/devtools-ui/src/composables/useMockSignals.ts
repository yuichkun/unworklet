import { computed, onScopeDispose, ref, watch } from "vue";

import { useMockGraph } from "./useMockGraph";

// Mock AnalyserNode-equivalent surface across every unworklet output port.
// Pretends to drive a per-port + per-channel ring buffer of recent audio + a
// realtime-budget latency rolling chart + a per-declaration memory accounting,
// all integrated so swapping the mock for the real signal probe / latency
// streaming / `result.memory` push in Phase 6 末 尾 keeps the panel UI intact.

const SAMPLE_RATE = 48_000;
const RING_DURATION_S = 10;
export const RING_TOTAL_SAMPLES = SAMPLE_RATE * RING_DURATION_S;
export const SAMPLE_RATE_HZ = SAMPLE_RATE;
const ANALYSER_FRAME_LEN = 512; // mimics half of fftSize = 1024

export type OutputPort = {
  nodeId: string;
  portName: string;
  channels: number;
};

const OUTPUT_PORTS: OutputPort[] = [
  { nodeId: "polysynth", portName: "main", channels: 2 },
  { nodeId: "limiter", portName: "main", channels: 2 },
  { nodeId: "reverb", portName: "main", channels: 2 },
];

export const portKey = (port: OutputPort): string => `${port.nodeId}.${port.portName}`;

const phase = ref(0);
let rafId: number | null = null;
let lastTs: number | null = null;
let subscribers = 0;

const tick = (ts: number): void => {
  if (lastTs === null) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  phase.value = (phase.value + dt) % 100_000;
  rafId = requestAnimationFrame(tick);
};

const startLoop = (): void => {
  if (rafId !== null) return;
  lastTs = null;
  rafId = requestAnimationFrame(tick);
};
const stopLoop = (): void => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  lastTs = null;
};

// ─────────────────────────────────────────────────────────────────────
// Time / frequency domain mocks per output port × channel
// ─────────────────────────────────────────────────────────────────────

const getTimeDomainFrame = (port: OutputPort, ch: number): Float32Array => {
  const out = new Float32Array(ANALYSER_FRAME_LEN);
  const t = phase.value;
  const base = 220 + Math.sin(t * 0.4) * 80;
  for (let i = 0; i < ANALYSER_FRAME_LEN; i++) {
    const x = i / ANALYSER_FRAME_LEN;
    if (port.nodeId === "polysynth") {
      out[i] = Math.sin((x + t * 0.5 + ch * 0.1) * Math.PI * 2 * 8 * (base / 220)) * 0.6;
    } else if (port.nodeId === "limiter") {
      out[i] =
        Math.tanh(Math.sin((x + t * 0.5 + ch * 0.1) * Math.PI * 2 * 8 * (base / 220)) * 1.2) * 0.5;
    } else {
      // reverb = layered diffuse
      let s = 0;
      for (let k = 1; k <= 5; k++) {
        s +=
          Math.sin((x + t * 0.3 + k * 0.05 + ch * 0.1) * Math.PI * 2 * 4 * (base / 220) * k) *
          (0.5 / k);
      }
      out[i] = s * 0.6;
    }
  }
  return out;
};

const getFreqDomainFrame = (port: OutputPort, ch: number): Float32Array => {
  const out = new Float32Array(ANALYSER_FRAME_LEN);
  const t = phase.value;
  for (let i = 0; i < ANALYSER_FRAME_LEN; i++) {
    const norm = i / ANALYSER_FRAME_LEN;
    if (port.nodeId === "polysynth") {
      const fundamental = Math.exp(-Math.abs(norm * 8 - 1) * 4);
      const second = Math.exp(-Math.abs(norm * 8 - 2) * 4) * 0.6;
      const third = Math.exp(-Math.abs(norm * 8 - 3) * 4) * 0.4;
      out[i] = (fundamental + second + third) * (0.7 + 0.3 * Math.sin(t * 1.5 + ch * 0.3));
    } else if (port.nodeId === "limiter") {
      const fundamental = Math.exp(-Math.abs(norm * 8 - 1) * 4);
      const second = Math.exp(-Math.abs(norm * 8 - 2) * 4) * 0.5;
      out[i] = (fundamental + second) * 0.55;
    } else {
      const lowDecay = Math.exp(-norm * 3);
      out[i] = lowDecay * (0.5 + 0.5 * Math.sin(t * 1.5 + norm * 6));
    }
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────
// Per-port × per-channel ring buffer (= 10 s rolling history)
// ─────────────────────────────────────────────────────────────────────

type RingChannel = {
  buffer: Float32Array;
  head: number;
};

type RingState = RingChannel[];

const ringStates = new Map<string, RingState>();
for (const port of OUTPUT_PORTS) {
  const channels: RingChannel[] = [];
  for (let c = 0; c < port.channels; c++) {
    channels.push({ buffer: new Float32Array(RING_TOTAL_SAMPLES), head: 0 });
  }
  ringStates.set(portKey(port), channels);
}

let lastRingTick = -1;
const RING_PUSH_INTERVAL_S = 1 / 60;

const updateRings = (t: number): void => {
  if (lastRingTick >= 0 && t - lastRingTick < RING_PUSH_INTERVAL_S && t > lastRingTick) return;
  const dt = lastRingTick < 0 ? RING_PUSH_INTERVAL_S : t - lastRingTick;
  lastRingTick = t;
  const samplesPerTick = Math.max(1, Math.round(dt * SAMPLE_RATE));
  for (const port of OUTPUT_PORTS) {
    const rings = ringStates.get(portKey(port));
    if (!rings) continue;
    for (let c = 0; c < port.channels; c++) {
      const ring = rings[c]!;
      const frame = getTimeDomainFrame(port, c);
      for (let i = 0; i < samplesPerTick; i++) {
        ring.buffer[ring.head] = frame[i % frame.length]!;
        ring.head = (ring.head + 1) % RING_TOTAL_SAMPLES;
      }
    }
  }
};

export const captureRing = (port: OutputPort): Float32Array[] => {
  const rings = ringStates.get(portKey(port));
  if (!rings) return [];
  return rings.map((ring) => {
    const out = new Float32Array(RING_TOTAL_SAMPLES);
    for (let i = 0; i < RING_TOTAL_SAMPLES; i++) {
      const idx = (ring.head + i) % RING_TOTAL_SAMPLES;
      out[i] = ring.buffer[idx]!;
    }
    return out;
  });
};

// ─────────────────────────────────────────────────────────────────────
// Latency mock = rolling chart per unworklet node + total
// ─────────────────────────────────────────────────────────────────────

const LATENCY_HISTORY_LEN = 200;
const LATENCY_NODE_IDS = ["polysynth", "limiter", "reverb"] as const;
export const LATENCY_TOTAL_KEY = "total" as const;

const latencyHistory: Record<string, number[]> = {
  polysynth: [],
  limiter: [],
  reverb: [],
  total: [],
};

const NODE_LATENCY_MEAN: Record<string, number> = {
  polysynth: 0.3,
  limiter: 0.1,
  reverb: 1.2,
};
const NODE_LATENCY_NOISE: Record<string, number> = {
  polysynth: 0.05,
  limiter: 0.02,
  reverb: 0.15,
};

let lastLatencyTick = -1;
const LATENCY_INTERVAL_S = 1 / 30;

const updateLatency = (t: number): void => {
  if (lastLatencyTick >= 0 && t - lastLatencyTick < LATENCY_INTERVAL_S && t > lastLatencyTick)
    return;
  lastLatencyTick = t;
  let total = 0;
  for (const node of LATENCY_NODE_IDS) {
    const mean = NODE_LATENCY_MEAN[node]!;
    const noise = NODE_LATENCY_NOISE[node]!;
    const r =
      (Math.sin(t * 10 + node.length * 3.7) + Math.sin(t * 7.3 + node.length * 1.7)) * 0.25 + 0.5;
    const v = Math.max(0, mean + (r - 0.5) * 2 * noise);
    latencyHistory[node]!.push(v);
    if (latencyHistory[node]!.length > LATENCY_HISTORY_LEN) latencyHistory[node]!.shift();
    total += v;
  }
  latencyHistory.total!.push(total);
  if (latencyHistory.total!.length > LATENCY_HISTORY_LEN) latencyHistory.total!.shift();
};

watch(phase, (t) => {
  updateRings(t);
  updateLatency(t);
});

export const getLatencyHistory = (nodeId: string): readonly number[] =>
  latencyHistory[nodeId] ?? [];

export type LatencyStats = { p50: number; p95: number; p99: number; max: number; mean: number };
export const getLatencyStats = (nodeId: string): LatencyStats => {
  const arr = (latencyHistory[nodeId] ?? []).slice().sort((a, b) => a - b);
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const pick = (q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))]!;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: arr[arr.length - 1]!, mean };
};

export const REALTIME_BUDGET_MS = (128 / SAMPLE_RATE) * 1000;

// ─────────────────────────────────────────────────────────────────────
// Memory mock = per-declaration roll-up from useMockGraph AST
// ─────────────────────────────────────────────────────────────────────

export type MemoryEntry = {
  nodeId: string;
  nodeLabel: string;
  bytes: number;
  declarations: Array<{ kind: string; name: string; bytes: number }>;
};

const useMockGraphLazy = () => useMockGraph();

export const computeMemoryRollup = (): MemoryEntry[] => {
  const graph = useMockGraphLazy();
  return graph.nodes
    .filter((n) => n.kind === "unworklet")
    .map((n) => {
      const decls = graph.astDecls(n.id);
      const bytes = decls.reduce((s, d) => s + d.bytes, 0);
      return {
        nodeId: n.id,
        nodeLabel: n.label,
        bytes,
        declarations: decls.map((d) => ({ kind: d.kind, name: d.name, bytes: d.bytes })),
      };
    });
};

export const MEMORY_WARN_BYTES = 64 * 1024 * 1024;
export const MEMORY_ERROR_BYTES = 4 * 1024 * 1024 * 1024;

export const useMockSignals = () => {
  subscribers += 1;
  startLoop();
  onScopeDispose(() => {
    subscribers -= 1;
    if (subscribers <= 0) stopLoop();
  });
  return {
    phase,
    ports: computed<readonly OutputPort[]>(() => OUTPUT_PORTS),
    getTimeDomainFrame,
    getFreqDomainFrame,
    captureRing,
    getLatencyHistory,
    getLatencyStats,
    realtimeBudgetMs: REALTIME_BUDGET_MS,
    latencyNodeIds: LATENCY_NODE_IDS,
    latencyTotalKey: LATENCY_TOTAL_KEY,
    computeMemoryRollup,
    memoryWarnBytes: MEMORY_WARN_BYTES,
    memoryErrorBytes: MEMORY_ERROR_BYTES,
    sampleRate: SAMPLE_RATE_HZ,
    ringTotalSamples: RING_TOTAL_SAMPLES,
  };
};
