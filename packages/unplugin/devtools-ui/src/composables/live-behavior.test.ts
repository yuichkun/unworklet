import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { type App, createApp, nextTick } from "vue";

import { getPanelRpc, type PanelRpc } from "../lib/rpc";
import { layout, type LiveGraph, useLiveGraph } from "./useLiveGraph";
import { type MidiShared, useLiveMidi } from "./useLiveMidi";
import { type LiveSignals, useLiveSignals } from "./useLiveSignals";
import { type LiveState, useLiveState } from "./useLiveState";

vi.mock("../lib/rpc", () => ({ getPanelRpc: vi.fn() }));

const apps: App[] = [];
const mount = <T>(useComposable: () => T): T => {
  let result!: T;
  const app = createApp({
    setup() {
      result = useComposable();
      return () => null;
    },
  });
  app.mount(document.createElement("div"));
  apps.push(app);
  return result;
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  vi.restoreAllMocks();
  vi.mocked(getPanelRpc).mockReset();
});

const graphData = (): LiveGraph => ({
  nodes: [
    { id: "synth", label: "Synth", kind: "unworklet", audioNodeType: "AudioWorkletNode" },
    { id: "out", label: "Output", kind: "standard", audioNodeType: "AudioDestinationNode" },
  ],
  edges: [{ id: "synth-out", from: "synth", to: "out" }],
});

test("graph selection follows live nodes and clears when a node or the snapshot disappears", async () => {
  const shared = createSharedState({ initialValue: graphData() });
  const get = vi.fn(async () => shared);
  vi.mocked(getPanelRpc).mockResolvedValue({ sharedState: { get } } as unknown as PanelRpc);
  const graph = mount(useLiveGraph);
  expect(graph.selectedNode.value).toBeNull();
  expect(graph.placed.value).toEqual([]);
  await flush();
  expect(get).toHaveBeenCalledWith("unworklet:graph");
  expect(graph.edges.value).toEqual(graphData().edges);
  expect(graph.placed.value.map((node) => [node.id, node.x])).toEqual([
    ["synth", 60],
    ["out", 270],
  ]);
  graph.selectNode("synth");
  expect(graph.selectedNode.value?.label).toBe("Synth");
  shared.mutate((state) => {
    state.nodes[0]!.label = "Renamed synth";
  });
  expect(graph.selectedId.value).toBe("synth");
  expect(graph.selectedNode.value?.label).toBe("Renamed synth");
  shared.mutate((state) => {
    state.nodes.shift();
    state.edges = [];
  });
  expect(graph.selectedId.value).toBeNull();
  expect(graph.selectedNode.value).toBeNull();
  graph.selectNode("out");
  shared.patch([{ op: "replace", path: [], value: undefined }]);
  expect(graph.graph.value).toEqual({ nodes: [], edges: [] });
  expect(graph.selectedId.value).toBeNull();
  expect(graph.edges.value).toEqual([]);
});

test("graph layout ignores edges whose source or destination is absent", () => {
  const graph = graphData();
  graph.edges = [
    { id: "missing-source", from: "gone", to: "out" },
    { id: "missing-target", from: "synth", to: "gone" },
  ];
  expect(layout(graph).map((node) => [node.id, node.x, node.y])).toEqual([
    ["synth", 60, 60],
    ["out", 60, 156],
  ]);
});

for (const kind of ["graph", "state"] as const) {
  for (const stage of ["rpc", "shared state"] as const) {
    test(`${kind} remains empty when ${stage} connection fails`, async () => {
      const error = new Error("DevTools disconnected");
      if (stage === "rpc") vi.mocked(getPanelRpc).mockRejectedValue(error);
      else {
        vi.mocked(getPanelRpc).mockResolvedValue({
          sharedState: { get: async () => Promise.reject(error) },
        } as unknown as PanelRpc);
      }
      const view = kind === "graph" ? mount(useLiveGraph) : mount(useLiveState);
      await flush();
      if ("graph" in view) expect(view.graph.value).toEqual({ nodes: [], edges: [] });
      else {
        expect(view.nodes.value).toEqual([]);
        expect(view.totalScalars.value).toBe(0);
      }
    });
  }
}

test("scalar histories cap at 150 polls, exclude i64, and prune removed nodes and slots", async () => {
  const shared = createSharedState<LiveState>({
    initialValue: {
      nodes: [
        {
          id: "synth",
          displayName: "Synth",
          scalars: [
            { name: "level", kind: "state", type: "f32", value: 0 },
            { name: "gate", kind: "state", type: "bool", value: false },
            { name: "count", kind: "state", type: "i64", value: "9007199254740993" },
          ],
          buffers: [],
        },
        {
          id: "filter",
          displayName: "Filter",
          scalars: [{ name: "cutoff", kind: "param", type: "f32", value: 440 }],
          buffers: [],
        },
      ],
    },
  });
  const get = vi.fn(async () => shared);
  vi.mocked(getPanelRpc).mockResolvedValue({ sharedState: { get } } as unknown as PanelRpc);
  const state = mount(useLiveState);
  expect(state.getHistory("missing", "slot")).toEqual([]);
  await flush();
  expect(get).toHaveBeenCalledWith("unworklet:state");
  expect(state.totalScalars.value).toBe(4);
  expect(state.getHistory("synth", "gate")).toEqual([0]);
  expect(state.getHistory("synth", "count")).toEqual([]);
  for (let i = 1; i <= 155; i++) {
    shared.mutate((snapshot) => {
      snapshot.nodes[0]!.scalars[0]!.value = i;
      snapshot.nodes[0]!.scalars[1]!.value = true;
    });
  }
  expect(state.getHistory("synth", "level")).toEqual(
    Array.from({ length: 150 }, (_, index) => index + 6),
  );
  expect(state.getHistory("synth", "gate")).toEqual(Array(150).fill(1));
  shared.mutate((snapshot) => {
    snapshot.nodes[0]!.scalars = snapshot.nodes[0]!.scalars.filter((slot) => slot.name === "level");
    snapshot.nodes.pop();
  });
  expect(state.totalScalars.value).toBe(1);
  expect(state.getHistory("synth", "gate")).toEqual([]);
  expect(state.getHistory("filter", "cutoff")).toEqual([]);
  expect(state.getHistory("synth", "level")).toHaveLength(150);
  shared.patch([{ op: "replace", path: [], value: undefined }]);
  expect(state.nodes.value).toEqual([]);
  expect(state.getHistory("synth", "level")).toEqual([]);
});

test("signals retries failed connections, shares one subscription, and replaces frames without rerendering structure", async () => {
  vi.mocked(getPanelRpc).mockRejectedValueOnce(new Error("offline"));
  const failed = mount(useLiveSignals);
  await flush();
  expect(failed.nodes.value).toEqual([]);
  expect(failed.context.value.sampleRate).toBe(0);
  expect(failed.getFrame("synth", "main")).toBeUndefined();

  const shared = createSharedState<LiveSignals>({
    initialValue: {
      nodes: [
        {
          id: "synth",
          displayName: "Synth",
          memory: [{ name: "phase", kind: "state", bytes: 4 }],
          memoryBytes: 4,
          ports: [{ name: "main", time: [0, 0.5], freq: [0.2], rms: 0.25, peak: 0.5 }],
        },
      ],
      context: { sampleRate: 48000, baseLatencyMs: 2.6, outputLatencyMs: 11.2 },
    },
  });
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error("state unavailable"))
    .mockResolvedValue(shared);
  const subscribe = vi.spyOn(shared, "on");
  vi.mocked(getPanelRpc).mockResolvedValue({ sharedState: { get } } as unknown as PanelRpc);
  mount(useLiveSignals);
  await flush();
  const current = mount(useLiveSignals);
  const second = mount(useLiveSignals);
  await flush();
  expect(get).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenLastCalledWith("unworklet:signals");
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(current.nodes.value).toBe(second.nodes.value);
  expect(current.nodes.value[0]).toEqual({
    id: "synth",
    displayName: "Synth",
    ports: ["main"],
    memory: [{ name: "phase", kind: "state", bytes: 4 }],
    memoryBytes: 4,
  });
  const structure = current.nodes.value;
  shared.mutate((snapshot) => {
    snapshot.nodes[0]!.ports[0]!.time = [0.75, -0.75];
    snapshot.nodes[0]!.ports[0]!.rms = 0.6;
    snapshot.context.baseLatencyMs = 2.61;
  });
  expect(current.nodes.value).toBe(structure);
  expect(current.getFrame("synth", "main")?.time).toEqual([0.75, -0.75]);
  expect(second.getFrame("synth", "main")?.rms).toBe(0.6);
  shared.mutate((snapshot) => {
    snapshot.nodes[0]!.ports = [{ name: "aux", time: [0.1], freq: [0], rms: 0.1, peak: 0.1 }];
    snapshot.context.sampleRate = 96000;
  });
  expect(current.nodes.value).not.toBe(structure);
  expect(current.nodes.value[0]!.ports).toEqual(["aux"]);
  expect(current.getFrame("synth", "main")).toBeUndefined();
  expect(current.getFrame("synth", "aux")?.time).toEqual([0.1]);
  expect(current.context.value.sampleRate).toBe(96000);
  shared.patch([{ op: "replace", path: [], value: undefined }]);
  expect(current.nodes.value).toEqual([]);
  expect(current.getFrame("synth", "aux")).toBeUndefined();
});

test("MIDI retries initialization, shares live snapshots, and injects only known targets", async () => {
  const event = { type: "noteOn", channel: 0, note: 60, velocity: 96 } as const;
  vi.mocked(getPanelRpc).mockRejectedValueOnce(new Error("offline"));
  const failed = mount(useLiveMidi);
  failed.injectMidi("synth.keys", event);
  await flush();
  expect(failed.ports.value).toEqual([]);
  expect(failed.log.value).toEqual([]);
  expect(failed.overflow.value).toEqual({});
  const shared = createSharedState<MidiShared>({
    initialValue: {
      ports: [{ nodeId: "synth", node: "Synth", name: "keys", direction: "in", overflow: 2 }],
      log: [{ seq: 1, ts: 100, dir: "inject", nodeId: "synth", port: "keys", event }],
    },
  });
  const call = vi.fn();
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error("state unavailable"))
    .mockResolvedValue(shared);
  const subscribe = vi.spyOn(shared, "on");
  vi.mocked(getPanelRpc).mockResolvedValue({ call, sharedState: { get } } as unknown as PanelRpc);
  mount(useLiveMidi);
  await flush();
  const current = mount(useLiveMidi);
  const second = mount(useLiveMidi);
  await flush();
  expect(get).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenLastCalledWith("unworklet:midi");
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(current.ports.value).toEqual([{ nodeId: "synth", portName: "keys", kind: "input" }]);
  expect(current.portKey(current.ports.value[0]!)).toBe("synth.keys");
  expect(current.overflow.value).toEqual({ "synth.keys": 2 });
  current.injectMidi("missing.keys", event);
  expect(call).not.toHaveBeenCalled();
  current.injectMidi("synth.keys", event);
  expect(call).toHaveBeenCalledExactlyOnceWith("unworklet:midi-inject", {
    nodeId: "synth",
    port: "keys",
    event,
  });
  shared.mutate((snapshot) => {
    snapshot.ports[0]!.overflow = 3;
    snapshot.log.push({ seq: 2, ts: 200, dir: "out", nodeId: "synth", port: "keys", event });
  });
  expect(current.log.value.map((entry) => entry.id)).toEqual([2, 1]);
  expect(second.overflow.value).toEqual({ "synth.keys": 3 });
  shared.patch([{ op: "replace", path: [], value: undefined }]);
  expect(current.ports.value).toEqual([]);
  expect(current.log.value).toEqual([]);
  current.injectMidi("synth.keys", event);
  expect(call).toHaveBeenCalledTimes(1);
});
