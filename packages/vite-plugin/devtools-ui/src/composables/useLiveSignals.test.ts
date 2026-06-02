import { expect, test } from "vite-plus/test";

import { type LiveSignals, normalizeSignals, structureSignature } from "./useLiveSignals";

test("normalizeSignals: undefined / empty → empty nodes + empty context", () => {
  expect(normalizeSignals(undefined)).toEqual({
    nodes: [],
    context: { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 },
  });
});

test("normalizeSignals: a port missing its arrays is coerced to empty frames (regression guard)", () => {
  // A version-skewed payload can omit time/freq/rms/peak on a port.
  const partial = {
    nodes: [{ id: "n1", displayName: "tape", ports: [{ name: "main" }] }],
  } as unknown as LiveSignals;
  const out = normalizeSignals(partial);
  const port = out.nodes[0]!.ports[0]!;
  expect(port.time).toEqual([]);
  expect(port.freq).toEqual([]);
  expect(port.rms).toBe(0);
  expect(port.peak).toBe(0);
  // Render loops can map over the frames safely.
  expect(() => port.time.map((x) => x)).not.toThrow();
});

test("normalizeSignals: missing node arrays default to empty", () => {
  const partial = { nodes: [{ id: "n1", displayName: "x" }] } as unknown as LiveSignals;
  const out = normalizeSignals(partial);
  expect(out.nodes[0]!.ports).toEqual([]);
  expect(out.nodes[0]!.memory).toEqual([]);
  expect(out.nodes[0]!.memoryBytes).toBe(0);
});

test("normalizeSignals: well-formed data passes through", () => {
  const full: LiveSignals = {
    nodes: [
      {
        id: "n1",
        displayName: "synth",
        ports: [{ name: "main", time: [0, 0.5, -0.5], freq: [0.1, 0.2], rms: 0.3, peak: 0.5 }],
        memory: [{ name: "phase", kind: "state", bytes: 4 }],
        memoryBytes: 4,
      },
    ],
    context: { sampleRate: 48000, baseLatencyMs: 2.6, outputLatencyMs: 11.2 },
  };
  expect(normalizeSignals(full)).toEqual(full);
});

test("structureSignature: stable across per-frame data, changes when layout changes", () => {
  const base: LiveSignals = {
    nodes: [
      {
        id: "n1",
        displayName: "synth",
        ports: [{ name: "main", time: [0], freq: [0], rms: 0.1, peak: 0.2 }],
        memory: [],
        memoryBytes: 1024,
      },
    ],
    context: { sampleRate: 48000, baseLatencyMs: 2.6, outputLatencyMs: 11.2 },
  };
  // Same layout, different per-frame samples + sub-ms latency jitter → same sig.
  const sameLayout: LiveSignals = {
    nodes: [
      {
        ...base.nodes[0]!,
        ports: [{ name: "main", time: [0.9, -0.9], freq: [0.4], rms: 0.8, peak: 0.95 }],
      },
    ],
    context: { sampleRate: 48000, baseLatencyMs: 2.61, outputLatencyMs: 11.18 },
  };
  expect(structureSignature(sameLayout)).toBe(structureSignature(base));

  // A new port → different sig.
  const newPort: LiveSignals = {
    nodes: [
      {
        ...base.nodes[0]!,
        ports: [
          { name: "main", time: [], freq: [], rms: 0, peak: 0 },
          { name: "aux", time: [], freq: [], rms: 0, peak: 0 },
        ],
      },
    ],
    context: base.context,
  };
  expect(structureSignature(newPort)).not.toBe(structureSignature(base));

  // A memory change → different sig (declared layout shifted).
  const newMem: LiveSignals = {
    nodes: [{ ...base.nodes[0]!, memoryBytes: 2048 }],
    context: base.context,
  };
  expect(structureSignature(newMem)).not.toBe(structureSignature(base));
});
