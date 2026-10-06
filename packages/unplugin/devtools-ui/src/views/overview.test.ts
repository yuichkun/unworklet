import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { type App, type Slots, createApp, h, nextTick, ref } from "vue";

import { type LiveGraph } from "../composables/useLiveGraph";
import { type LiveState } from "../composables/useLiveState";
import { getPanelRpc, type PanelRpc } from "../lib/rpc";
import AudioGraphView from "./AudioGraphView.vue";
import SignalsView from "./SignalsView.vue";

const signal = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("../composables/useLiveSignals", () => ({ useLiveSignals: () => signal.data }));
vi.mock("../components/PortChannelView.vue", () => ({
  default: {
    props: ["nodeId", "portName"],
    render(this: { nodeId: string; portName: string }) {
      return h("div", { class: "port-output" }, `${this.nodeId}.${this.portName}`);
    },
  },
}));
vi.mock("../lib/rpc", () => ({ getPanelRpc: vi.fn() }));
vi.mock("@vue-flow/background", () => ({
  BackgroundVariant: { Dots: "dots" },
  Background: { render: () => null },
}));
vi.mock("@vue-flow/controls", () => ({ Controls: { render: () => null } }));
vi.mock("@vue-flow/core", () => ({
  Position: { Left: "left", Right: "right" },
  MarkerType: { ArrowClosed: "closed" },
  Handle: { render: () => null },
  VueFlow: {
    props: ["nodes", "edges"],
    emits: ["node-click"],
    setup(
      props: { nodes: { id: string; selected: boolean }[]; edges: unknown[] },
      { emit, slots }: { emit: (name: string, event: unknown) => void; slots: Slots },
    ) {
      return () =>
        h("div", { class: "flow", "data-edges": JSON.stringify(props.edges) }, [
          ...props.nodes.map((node) =>
            h(
              "button",
              {
                "data-id": node.id,
                "data-selected": node.selected,
                onClick: () => emit("node-click", { node }),
              },
              node.id,
            ),
          ),
          slots.default?.(),
        ]);
    },
  },
}));
const apps: App[] = [];
const roots: HTMLElement[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  for (const root of roots.splice(0)) root.remove();
  vi.clearAllMocks();
});
const mount = (component: Parameters<typeof createApp>[0]) => {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const app = createApp(component);
  apps.push(app);
  app.provide("unworklet:page-id", ref("page-a"));
  app.mount(root);
  return root;
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
};
const forPage = <T extends object>(shared: ReturnType<typeof createSharedState<T>>) => ({
  value: () => ({ pages: { "page-a": shared.value() } }),
  on: (_event: string, callback: (value: unknown) => void) =>
    shared.on("updated", (value) => callback({ pages: { "page-a": value } })),
});

test("graph selection shows topology, declared ports and typed state without inventing data", async () => {
  const graph = createSharedState<LiveGraph>({ initialValue: { nodes: [], edges: [] } });
  const state = createSharedState<LiveState>({ initialValue: { nodes: [] } });
  vi.mocked(getPanelRpc).mockResolvedValue({
    sharedState: {
      get: async (key: string) =>
        key === "unworklet:page-graph" ? forPage(graph) : forPage(state),
    },
  } as unknown as PanelRpc);
  const root = mount(AudioGraphView);
  await flush();
  expect(root.textContent).toContain("No live audio nodes");
  expect(root.querySelector(".detail-head")).toBeNull();
  graph.mutate((g) => {
    g.nodes = [
      { id: "n1", kind: "unworklet", label: "synth", audioNodeType: "AudioWorkletNode" },
      { id: "n2", kind: "standard", label: "gain", audioNodeType: "GainNode" },
    ];
  });
  await flush();
  root.querySelector<HTMLButtonElement>('[data-id="n1"]')!.click();
  await flush();
  expect(root.textContent).toContain("Start the app's audio to X-ray");
  expect(root.querySelector('[data-id="n1"]')!.getAttribute("data-selected")).toBe("true");
  graph.mutate((g) => {
    g.nodes[0]!.inputs = ["main"];
    g.nodes[0]!.outputs = ["out"];
    g.edges = [
      { id: "a", from: "n2", to: "n1" },
      { id: "b", from: "n1", to: "gone" },
    ];
  });
  state.mutate((s) => {
    s.nodes = [
      {
        id: "n1",
        displayName: "synth",
        scalars: [
          { name: "gain", kind: "param", type: "f32", value: 0.25 },
          { name: "double", kind: "state", type: "f64", value: 0.75 },
          { name: "yes", kind: "state", type: "bool", value: true },
          { name: "no", kind: "state", type: "bool", value: false },
          { name: "ticks", kind: "state", type: "i64", value: "9007199254740993" },
          { name: "count", kind: "state", type: "i32", value: 3 },
        ],
        buffers: [{ name: "history", type: "f32", length: 32, data: [], downsampled: false }],
      },
    ];
  });
  await flush();
  for (const text of [
    "main",
    "out",
    "gone",
    "0.250",
    "0.750",
    "true",
    "false",
    "9007199254740993",
    "× 32",
  ])
    expect(root.textContent).toContain(text);
  expect(root.querySelector(".flow")!.getAttribute("data-edges")).toContain('"source":"n2"');
  root.querySelector<HTMLButtonElement>('[data-id="n2"]')!.click();
  await flush();
  expect(root.textContent).toContain("Standard Web-Audio node");
  root.querySelector<HTMLButtonElement>('[data-id="n1"]')!.click();
  await flush();
  state.mutate((s) => {
    s.nodes[0]!.scalars = [];
    s.nodes[0]!.buffers = [];
  });
  graph.mutate((g) => {
    g.nodes[0]!.inputs = [];
    g.nodes[0]!.outputs = [];
    g.edges = [];
  });
  await flush();
  expect(root.querySelectorAll(".kv-row")).toHaveLength(0);
  graph.mutate((g) => {
    g.nodes = [];
  });
  await flush();
  expect(root.querySelector(".detail-head")).toBeNull();
  expect(root.textContent).toContain("No live audio nodes");
});

test("signals tabs show empty states, live ports, latency, memory units and budget saturation", async () => {
  const nodes = ref<
    {
      id: string;
      displayName: string;
      ports: string[];
      memoryBytes: number;
      memory: { name: string; kind: string; bytes: number }[];
    }[]
  >([]);
  const context = ref({ sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 });
  signal.data = { nodes, context };
  const root = mount(SignalsView);
  expect(root.textContent).toContain("No live output ports");
  expect(root.textContent).toContain("— Hz");
  const tab = async (text: string) => {
    [...root.querySelectorAll<HTMLButtonElement>(".sub-tab")]
      .find((el) => el.textContent === text)!
      .click();
    await nextTick();
  };
  await tab("Latency");
  expect(root.querySelectorAll(".latency-card-val")[0]!.textContent).toBe("—");
  context.value = { sampleRate: 48000, baseLatencyMs: 2.333, outputLatencyMs: 4.555 };
  await nextTick();
  expect(root.textContent).toContain("2.33 ms");
  expect(root.textContent).toContain("4.55 ms");
  await tab("Memory");
  expect(root.textContent).toContain("No unworklet nodes yet");
  nodes.value = [
    {
      id: "n1",
      displayName: "delay",
      ports: ["out"],
      memoryBytes: 2 ** 30,
      memory: [
        { name: "flag", kind: "state", bytes: 4 },
        { name: "line", kind: "buffer", bytes: 2048 },
        { name: "large", kind: "buffer", bytes: 2 ** 20 },
        { name: "huge", kind: "buffer", bytes: 2 ** 30 },
      ],
    },
    { id: "n2", displayName: "empty", ports: [], memoryBytes: 0, memory: [] },
  ];
  await nextTick();
  for (const text of ["4 B", "2.0 KB", "1.00 MB", "1.00 GB", "no dumpable slots"])
    expect(root.textContent).toContain(text);
  expect(root.querySelector<HTMLElement>(".memory-budget-fill")!.style.width).toBe("100.00%");
  await tab("Audio");
  expect(root.querySelector(".port-head-name")!.textContent).toBe("delay.out");
  expect(root.querySelector(".port-output")!.textContent).toBe("n1.out");
});
