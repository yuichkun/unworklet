import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { expect, test, vi } from "vite-plus/test";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "../App.vue";
import { getPanelRpc, type PanelRpc } from "../lib/rpc";
import MidiView from "../views/MidiView.vue";
import { useLiveGraph } from "./useLiveGraph";
import { useLiveState } from "./useLiveState";
import { useLiveSignals } from "./useLiveSignals";

vi.mock("../lib/rpc", () => ({ getPanelRpc: vi.fn() }));
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await nextTick();
};
const page = (id: string) => ({ id, title: "Same app", url: "http://localhost:5173/" });
const data = (value: number) => ({
  nodes: [
    {
      id: "n0",
      label: `synth ${value}`,
      kind: "unworklet",
      audioNodeType: "AudioWorkletNode",
      displayName: `synth ${value}`,
      scalars: [{ name: "level", kind: "state", type: "f32", value }],
      buffers: [],
      ports: [{ name: "out", time: [value], freq: [value], rms: value, peak: value }],
      memory: [],
      memoryBytes: 0,
    },
  ],
  edges: [],
  context: { sampleRate: 48000, baseLatencyMs: 0, outputLatencyMs: 0 },
});

test("page selector isolates matching nodes, resets live histories/frames, and never silently selects a survivor", async () => {
  const pages = createSharedState({
    initialValue: { pages: [{ ...page("a"), title: "" }, page("b")] },
  });
  const snapshots = createSharedState({ initialValue: { pages: { a: data(1), b: data(2) } } });
  vi.mocked(getPanelRpc).mockResolvedValue({
    sharedState: { get: async (key: string) => (key === "unworklet:pages" ? pages : snapshots) },
  } as unknown as PanelRpc);
  let current!: {
    graph: ReturnType<typeof useLiveGraph>;
    state: ReturnType<typeof useLiveState>;
    signals: ReturnType<typeof useLiveSignals>;
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/",
        component: {
          setup() {
            current = { graph: useLiveGraph(), state: useLiveState(), signals: useLiveSignals() };
            return () => h("p", "Live");
          },
        },
      },
    ],
  });
  const root = document.createElement("div");
  const app = createApp(App).use(router);
  app.mount(root);
  try {
    await router.isReady();
    await flush();
    expect(current.graph.graph.value.nodes[0]!.label).toBe("synth 1");
    current.graph.selectNode("n0");
    expect(current.state.getHistory("n0", "level")).toEqual([1]);
    expect(current.signals.getFrame("n0", "out")!.time).toEqual([1]);
    snapshots.mutate((draft) => {
      draft.pages.b.context.sampleRate = 96000;
    });
    expect(current.state.getHistory("n0", "level")).toEqual([1]);
    const selector = root.querySelector<HTMLSelectElement>(".page-selector select")!;
    selector.value = "b";
    selector.dispatchEvent(new Event("change"));
    await flush();
    expect(current.graph.graph.value.nodes[0]!.label).toBe("synth 2");
    expect(current.graph.selectedId.value).toBeNull();
    expect(current.state.getHistory("n0", "level")).toEqual([2]);
    expect(current.signals.getFrame("n0", "out")!.time).toEqual([2]);
    snapshots.mutate((draft) => {
      delete (draft.pages as Partial<typeof draft.pages>).b;
    });
    pages.mutate((draft) => {
      draft.pages = [page("a")];
    });
    await flush();
    expect(selector.value).toBe("b");
    expect(current.graph.graph.value.nodes).toEqual([]);
    expect(current.state.getHistory("n0", "level")).toEqual([]);
    expect(current.signals.getFrame("n0", "out")).toBeUndefined();
  } finally {
    app.unmount();
  }
});

test("switching pages releases held notes on their original page and targets only the explicit new selection", async () => {
  const pages = createSharedState({
    initialValue: { pages: [{ ...page("a"), title: "" }, page("b")] },
  });
  const midi = {
    ports: [{ nodeId: "n0", node: "synth", name: "in", direction: "in", overflow: 0 }],
    log: [],
  };
  const snapshots = createSharedState({ initialValue: { pages: { a: midi, b: midi } } });
  const call = vi.fn();
  vi.mocked(getPanelRpc).mockResolvedValue({
    call,
    sharedState: { get: async (key: string) => (key === "unworklet:pages" ? pages : snapshots) },
  } as unknown as PanelRpc);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: MidiView }],
  });
  const root = document.createElement("div");
  const app = createApp(App).use(router);
  app.mount(root);
  try {
    await router.isReady();
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    const selector = root.querySelector<HTMLSelectElement>(".page-selector select")!;
    selector.value = "b";
    selector.dispatchEvent(new Event("change"));
    await flush();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    expect(call.mock.calls.map(([, cmd]) => [cmd.pageId, cmd.nodeId, cmd.event.type])).toEqual([
      ["a", "n0", "noteOn"],
      ["a", "n0", "noteOff"],
      ["b", "n0", "noteOn"],
      ["b", "n0", "noteOff"],
    ]);
  } finally {
    app.unmount();
  }
});

for (const stage of ["rpc", "shared"] as const) {
  test(`page list does not subscribe or apply data after unmount during ${stage}`, async () => {
    const { useLivePages } = await import("./useLivePages");
    const shared = createSharedState({ initialValue: { pages: [page("late")] } });
    const subscribe = vi.spyOn(shared, "on");
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const rpc = {
      sharedState: { get: () => (stage === "shared" ? pending : Promise.resolve(shared)) },
    };
    vi.mocked(getPanelRpc).mockReturnValue(
      (stage === "rpc" ? pending : Promise.resolve(rpc)) as Promise<PanelRpc>,
    );
    let current!: ReturnType<typeof useLivePages>;
    const app = createApp({
      setup() {
        current = useLivePages();
        return () => null;
      },
    });
    app.mount(document.createElement("div"));
    await nextTick();
    await Promise.resolve();
    app.unmount();
    resolve(stage === "rpc" ? rpc : shared);
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(current.pages.value).toEqual([]);
  });
}

test("page list accepts empty snapshots and initially selects only the first live page", async () => {
  const { useLivePages } = await import("./useLivePages");
  const shared = createSharedState({ initialValue: { pages: [] as ReturnType<typeof page>[] } });
  vi.mocked(getPanelRpc).mockResolvedValue({
    sharedState: { get: async () => shared },
  } as unknown as PanelRpc);
  let current!: ReturnType<typeof useLivePages>;
  const app = createApp({
    setup() {
      current = useLivePages();
      return () => null;
    },
  });
  app.mount(document.createElement("div"));
  try {
    await flush();
    expect(current.selectedPageId.value).toBe("");
    shared.mutate((draft) => {
      draft.pages.push(page("first"));
    });
    expect(current.selectedPageId.value).toBe("first");
    shared.patch([{ op: "replace", path: [], value: undefined }]);
    expect(current.pages.value).toEqual([]);
    expect(current.selectedPageId.value).toBe("first");
  } finally {
    app.unmount();
  }
});

test("signals share the selected view's frames with child ports without extra subscriptions", async () => {
  const shared = createSharedState({ initialValue: { pages: { a: data(3) } } });
  const get = vi.fn(async () => shared);
  vi.mocked(getPanelRpc).mockResolvedValue({ sharedState: { get } } as unknown as PanelRpc);
  let parent!: ReturnType<typeof useLiveSignals>;
  let child!: ReturnType<typeof useLiveSignals>;
  const port = {
    setup() {
      child = useLiveSignals();
      return () => null;
    },
  };
  const app = createApp({
    setup() {
      parent = useLiveSignals();
      return () => h(port);
    },
  });
  const { ref } = await import("vue");
  app.provide("unworklet:page-id", ref("a"));
  app.mount(document.createElement("div"));
  try {
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    expect(child).toBe(parent);
    expect(child.getFrame("n0", "out")!.time).toEqual([3]);
  } finally {
    app.unmount();
  }
});
