import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { expect, test, vi } from "vite-plus/test";
import { createApp, nextTick } from "vue";

import { getPanelRpc, type PanelRpc } from "../lib/rpc";
import MidiView from "./MidiView.vue";

vi.mock("../lib/rpc", () => ({ getPanelRpc: vi.fn() }));

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
    sharedState: { get: async () => shared },
    call,
  } as unknown as PanelRpc);
  const root = document.createElement("div");
  const app = createApp(MidiView);
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
        "unworklet:midi-inject",
        { nodeId: "n1", port: "in", event: { type: "noteOn", channel: 0, note: 60, velocity: 96 } },
      ],
      [
        "unworklet:midi-inject",
        { nodeId: "n1", port: "in", event: { type: "noteOff", channel: 0, note: 60, velocity: 0 } },
      ],
      [
        "unworklet:midi-inject",
        { nodeId: "n2", port: "in", event: { type: "noteOn", channel: 0, note: 60, velocity: 96 } },
      ],
      [
        "unworklet:midi-inject",
        { nodeId: "n2", port: "in", event: { type: "noteOff", channel: 0, note: 60, velocity: 0 } },
      ],
    ]);
  } finally {
    // The root is empty once unmounted, including when an assertion fails.
    if (root.hasChildNodes()) app.unmount();
  }
});
