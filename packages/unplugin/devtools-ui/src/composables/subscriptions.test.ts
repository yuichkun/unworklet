import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { type App, createApp, nextTick, ref } from "vue";

import { getPanelRpc, type PanelRpc } from "../lib/rpc";
import { useLiveGraph } from "./useLiveGraph";
import { useLiveState } from "./useLiveState";

vi.mock("../lib/rpc", () => ({ getPanelRpc: vi.fn() }));
const apps: App[] = [];
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  vi.clearAllMocks();
});
const forPage = <T extends object>(shared: ReturnType<typeof createSharedState<T>>) => ({
  value: () => ({ pages: { "page-a": shared.value() } }),
  on: (_event: string, callback: (value: unknown) => void) =>
    shared.on("updated", (value) => callback({ pages: { "page-a": value } })),
});

for (const kind of ["graph", "state"] as const) {
  const initial = () => ({ nodes: [], edges: [] });
  const updated = () => ({
    nodes: [
      {
        id: "n1",
        label: "synth",
        kind: "unworklet",
        audioNodeType: "AudioWorkletNode",
        displayName: "synth",
        scalars: [{ name: "level", kind: "state", type: "f32", value: 1 }],
        buffers: [],
      },
    ],
    edges: [],
  });
  const mount = () => {
    let read!: () => unknown;
    const app = createApp({
      setup() {
        if (kind === "graph") {
          const graph = useLiveGraph();
          read = () => graph.graph.value;
        } else {
          const state = useLiveState();
          read = () => ({
            nodes: state.nodes.value,
            history: [...state.getHistory("n1", "level")],
          });
        }
        return () => null;
      },
    });
    app.provide("unworklet:page-id", ref("page-a"));
    app.mount(document.createElement("div"));
    apps.push(app);
    return { app, read: () => read() };
  };

  test(`${kind}: repeated route changes detach updates and keep the live view subscribed`, async () => {
    const shared = createSharedState({ initialValue: initial() as ReturnType<typeof updated> });
    vi.mocked(getPanelRpc).mockResolvedValue({
      sharedState: { get: async () => forPage(shared) },
    } as unknown as PanelRpc);
    const old = [];
    for (let i = 0; i < 10; i++) {
      const view = mount();
      await flush();
      view.app.unmount();
      apps.pop();
      old.push({ view, snapshot: view.read() });
    }
    const current = mount();
    await flush();
    shared.mutate((state) => {
      state.nodes = updated().nodes;
    });
    await flush();
    expect(current.read()).not.toEqual(old[0]!.snapshot);
    for (const { view, snapshot } of old) expect(view.read()).toEqual(snapshot);
  });

  for (const stage of ["rpc", "shared state"] as const) {
    test(`${kind}: unmount while awaiting ${stage} does not subscribe or apply late data`, async () => {
      const shared = createSharedState({ initialValue: updated() });
      const subscribe = vi.spyOn(shared, "on");
      let resolve!: (value: unknown) => void;
      const pending = new Promise((done) => {
        resolve = done;
      });
      const rpc = {
        sharedState: {
          get: () => (stage === "shared state" ? pending : Promise.resolve(forPage(shared))),
        },
      };
      vi.mocked(getPanelRpc).mockReturnValue(
        (stage === "rpc" ? pending : Promise.resolve(rpc)) as Promise<PanelRpc>,
      );
      const view = mount();
      await flush();
      const snapshot = view.read();
      view.app.unmount();
      apps.pop();
      resolve(stage === "rpc" ? rpc : forPage(shared));
      await flush();
      expect(subscribe).not.toHaveBeenCalled();
      expect(view.read()).toEqual(snapshot);
    });
  }
}
