import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { expect, test, vi } from "vite-plus/test";
import { createApp, nextTick, ref } from "vue";

import { getPanelRpc, type PanelRpc } from "../lib/rpc";
import MidiView from "./MidiView.vue";

vi.mock("../lib/rpc", () => ({ getPanelRpc: vi.fn() }));
const forPage = <T extends object>(shared: ReturnType<typeof createSharedState<T>>) => ({
  value: () => ({ pages: { "page-a": shared.value() } }),
  on: (_event: string, callback: (value: unknown) => void) =>
    shared.on("updated", (value) => callback({ pages: { "page-a": value } })),
});

test("MIDI routing changes and route exit send balanced note events through the real composable", async () => {
  const shared = createSharedState({
    initialValue: {
      ports: ["n1", "n2"].map((nodeId) => ({
        nodeId,
        node: "synth",
        name: "in",
        direction: "in",
        overflow: 0,
      })),
      log: [],
    },
  });
  const call = vi.fn();
  vi.mocked(getPanelRpc).mockResolvedValue({
    sharedState: { get: async () => forPage(shared) },
    call,
  } as unknown as PanelRpc);
  const root = document.createElement("div");
  const app = createApp(MidiView);
  app.provide("unworklet:page-id", ref("page-a"));
  app.mount(root);
  try {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    const select = root.querySelector<HTMLSelectElement>(".inject-routing select")!;
    select.value = "n2.in";
    select.dispatchEvent(new Event("change"));
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    app.unmount();
    expect(call.mock.calls).toEqual([
      [
        "unworklet:page-midi-inject",
        {
          pageId: "page-a",
          nodeId: "n1",
          port: "in",
          event: { type: "noteOn", channel: 0, note: 60, velocity: 96 },
        },
      ],
      [
        "unworklet:page-midi-inject",
        {
          pageId: "page-a",
          nodeId: "n1",
          port: "in",
          event: { type: "noteOff", channel: 0, note: 60, velocity: 0 },
        },
      ],
      [
        "unworklet:page-midi-inject",
        {
          pageId: "page-a",
          nodeId: "n2",
          port: "in",
          event: { type: "noteOn", channel: 0, note: 60, velocity: 96 },
        },
      ],
      [
        "unworklet:page-midi-inject",
        {
          pageId: "page-a",
          nodeId: "n2",
          port: "in",
          event: { type: "noteOff", channel: 0, note: 60, velocity: 0 },
        },
      ],
    ]);
  } finally {
    // The root is empty once unmounted, including when an assertion fails.
    if (root.hasChildNodes()) app.unmount();
  }
});

test.each([64, 66, 69])(
  "page switching releases CC%s through the view's captured page and input",
  async (controllerNumber) => {
    const shared = createSharedState({
      initialValue: {
        ports: [{ nodeId: "n1", node: "synth", name: "in", direction: "in", overflow: 0 }],
        log: [],
      },
    });
    const call = vi.fn();
    vi.mocked(getPanelRpc).mockResolvedValue({
      sharedState: { get: async () => forPage(shared) },
      call,
    } as unknown as PanelRpc);
    const root = document.createElement("div");
    const selected = ref("page-a");
    const app = createApp(MidiView);
    app.provide("unworklet:page-id", selected);
    app.mount(root);
    try {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await nextTick();
      const controller = root.querySelector<HTMLInputElement>(".ctrl-row-aux input")!;
      controller.value = String(controllerNumber);
      controller.dispatchEvent(new Event("input"));
      await nextTick();
      const slider = root.querySelectorAll<HTMLElement>(".range-slider")[1]!;
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 127 } as DOMRect);
      slider.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 127 }));
      await nextTick();
      selected.value = "page-b";
      app.unmount();
      expect(call.mock.calls).toEqual(
        [127, 0].map((value) => [
          "unworklet:page-midi-inject",
          {
            pageId: "page-a",
            nodeId: "n1",
            port: "in",
            event: { type: "cc", channel: 0, controller: controllerNumber, value },
          },
        ]),
      );
    } finally {
      if (root.hasChildNodes()) app.unmount();
    }
  },
);
