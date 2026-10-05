import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { type App, createApp, nextTick, ref } from "vue";

import { type MidiPortMeta } from "../composables/useLiveMidi";
import MidiView from "./MidiView.vue";

const fixture = vi.hoisted(() => ({ injectMidi: vi.fn(), ports: null as unknown }));
vi.mock("../composables/useLiveMidi", async (original) => {
  const actual = await original<typeof import("../composables/useLiveMidi")>();
  return {
    ...actual,
    useLiveMidi: () => ({
      ports: fixture.ports,
      log: ref([]),
      overflow: ref({}),
      injectMidi: fixture.injectMidi,
    }),
  };
});
let app: App | undefined;
let root: HTMLDivElement;
const ports = ref<MidiPortMeta[]>([]);
beforeEach(() => {
  ports.value = ["n1", "n2"].map((nodeId) => ({ nodeId, portName: "in", kind: "input" }));
  fixture.ports = ports;
  fixture.injectMidi.mockClear();
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(MidiView);
  app.mount(root);
});
afterEach(() => {
  app?.unmount();
  root.remove();
});
const key = (type: string, name = "a", options: KeyboardEventInit = {}) => {
  window.dispatchEvent(new KeyboardEvent(type, { key: name, ...options }));
};
const released = () => ["n1.in", { type: "noteOff", channel: 0, note: 60, velocity: 0 }];

test.each(["channel", "target"])(
  "changing %s releases the held note at its original destination",
  async (routing) => {
    key("keydown");
    expect(fixture.injectMidi).toHaveBeenLastCalledWith("n1.in", {
      type: "noteOn",
      channel: 0,
      note: 60,
      velocity: 96,
    });
    if (routing === "channel") {
      const input = root.querySelector<HTMLInputElement>(".inject-routing input")!;
      input.value = "1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const select = root.querySelector<HTMLSelectElement>(".inject-routing select")!;
      select.value = "n2.in";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await nextTick();
    expect(fixture.injectMidi).toHaveBeenLastCalledWith(...released());
    expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
    key("keyup");
    expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
    key("keydown");
    expect(fixture.injectMidi).toHaveBeenLastCalledWith(routing === "target" ? "n2.in" : "n1.in", {
      type: "noteOn",
      channel: routing === "channel" ? 1 : 0,
      note: 60,
      velocity: 96,
    });
  },
);

test("route unmount releases notes and removes key listeners", () => {
  key("keydown");
  app!.unmount();
  app = undefined;
  expect(fixture.injectMidi).toHaveBeenLastCalledWith(...released());
  key("keyup");
  key("keydown");
  expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
});

test("Panic releases notes, clears physical keys, and broadcasts all channels", () => {
  key("keydown");
  root.querySelector<HTMLButtonElement>(".panic-btn")!.click();
  expect(fixture.injectMidi.mock.calls[1]).toEqual(released());
  expect(fixture.injectMidi).toHaveBeenCalledTimes(18);
  for (let channel = 0; channel < 16; channel++)
    expect(fixture.injectMidi.mock.calls[channel + 2]).toEqual([
      "n1.in",
      { type: "cc", channel, controller: 123, value: 0 },
    ]);
  key("keyup");
  expect(fixture.injectMidi).toHaveBeenCalledTimes(18);
  key("keydown");
  expect(fixture.injectMidi).toHaveBeenCalledTimes(19);
});

test("octave changes release the original note and key repeat does not retrigger", () => {
  key("keydown");
  key("keydown", "a", { repeat: true });
  key("keydown", "x");
  key("keyup");
  expect(fixture.injectMidi.mock.calls).toEqual([
    ["n1.in", { type: "noteOn", channel: 0, note: 60, velocity: 96 }],
    released(),
  ]);
});

test("losing the input target releases held notes and an empty target cannot hold a note", async () => {
  key("keydown");
  ports.value = [];
  await nextTick();
  expect(fixture.injectMidi).toHaveBeenLastCalledWith(...released());
  key("keyup");
  key("keydown");
  key("keyup");
  expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
});

test("mouse and PC notes are both released when the view closes", () => {
  key("keydown", "s");
  root.querySelector<HTMLButtonElement>(".key-white")!.dispatchEvent(new MouseEvent("mousedown"));
  expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
  app!.unmount();
  app = undefined;
  expect(fixture.injectMidi.mock.calls.slice(2)).toEqual([
    ["n1.in", { type: "noteOff", channel: 0, note: 62, velocity: 0 }],
    released(),
  ]);
});
