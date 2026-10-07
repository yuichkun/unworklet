import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { type App, createApp, nextTick, ref } from "vue";

import { type MidiLogEntry, type MidiEvent, type MidiPortMeta } from "../composables/useLiveMidi";
import MidiView from "./MidiView.vue";

const fixture = vi.hoisted(() => ({
  injectMidi: vi.fn(),
  ports: null as unknown,
  log: null as unknown,
  overflow: null as unknown,
}));
vi.mock("../composables/useLiveMidi", async (original) => {
  const actual = await original<typeof import("../composables/useLiveMidi")>();
  return {
    ...actual,
    useLiveMidi: () => ({
      ports: fixture.ports,
      log: fixture.log,
      overflow: fixture.overflow,
      injectMidi: fixture.injectMidi,
    }),
  };
});
let app: App | undefined;
let root: HTMLDivElement;
const ports = ref<MidiPortMeta[]>([]);
const log = ref<MidiLogEntry[]>([]);
const overflow = ref<Record<string, number>>({});
beforeEach(() => {
  ports.value = ["n1", "n2"].map((nodeId) => ({ nodeId, portName: "in", kind: "input" }));
  fixture.ports = ports;
  log.value = [];
  overflow.value = {};
  fixture.log = log;
  fixture.overflow = overflow;
  fixture.injectMidi.mockClear();
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(MidiView);
  app.mount(root);
});
afterEach(() => {
  app?.unmount();
  root.remove();
  vi.restoreAllMocks();
});
const key = (type: string, name = "a", options: KeyboardEventInit = {}) => {
  window.dispatchEvent(new KeyboardEvent(type, { key: name, ...options }));
};
const released = () => ["n1.in", { type: "noteOff", channel: 0, note: 60, velocity: 0 }];

test.each(["mouseleave", "mouseup"])("%s cannot release a PC-held note", (type) => {
  key("keydown");
  root.querySelector<HTMLButtonElement>(".key-white")!.dispatchEvent(new MouseEvent(type));
  expect(fixture.injectMidi).toHaveBeenCalledTimes(1);
  key("keyup");
  expect(fixture.injectMidi.mock.calls).toHaveLength(2);
  expect(fixture.injectMidi).toHaveBeenLastCalledWith(...released());
});

test.each([
  ["mouse", "mouse"],
  ["mouse", "keyboard"],
  ["keyboard", "mouse"],
  ["keyboard", "keyboard"],
])("same note pressed first by %s and released first by %s stays held", (firstDown, firstUp) => {
  const button = root.querySelector<HTMLButtonElement>(".key-white")!;
  const down = (source: string) =>
    source === "mouse" ? button.dispatchEvent(new MouseEvent("mousedown")) : key("keydown");
  const up = (source: string) =>
    source === "mouse" ? button.dispatchEvent(new MouseEvent("mouseup")) : key("keyup");
  const other = (source: string) => (source === "mouse" ? "keyboard" : "mouse");
  down(firstDown);
  down(other(firstDown));
  expect(fixture.injectMidi).toHaveBeenCalledTimes(1);
  up(firstUp);
  expect(fixture.injectMidi).toHaveBeenCalledTimes(1);
  up(other(firstUp));
  expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
  expect(fixture.injectMidi).toHaveBeenLastCalledWith(...released());
});

test.each(["channel", "target"])(
  "changing %s releases the held note at its original destination",
  async (routing) => {
    key("keydown");
    root.querySelector<HTMLButtonElement>(".key-white")!.dispatchEvent(new MouseEvent("mousedown"));
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
    root.querySelector<HTMLButtonElement>(".key-white")!.dispatchEvent(new MouseEvent("mouseup"));
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

test.each([false, true])(
  "octave removal clears mouse ownership with PC hold %s",
  async (pcHeld) => {
    const button = root.querySelector<HTMLButtonElement>(".key-white")!;
    button.dispatchEvent(new MouseEvent("mousedown"));
    if (pcHeld) key("keydown");
    key("keydown", "x");
    await nextTick();
    expect(button.isConnected).toBe(false);
    expect(fixture.injectMidi).toHaveBeenCalledTimes(pcHeld ? 1 : 2);
    root.querySelector<HTMLButtonElement>(".key-white")!.dispatchEvent(new MouseEvent("mouseup"));
    if (pcHeld) key("keyup");
    expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
    expect(fixture.injectMidi).toHaveBeenLastCalledWith(...released());
  },
);

test("octave changes retain mouse ownership of keys still rendered", async () => {
  const button = root.querySelector<HTMLButtonElement>(".key-white")!;
  button.dispatchEvent(new MouseEvent("mousedown"));
  key("keydown", "z");
  await nextTick();
  expect(button.isConnected).toBe(true);
  expect(fixture.injectMidi).toHaveBeenCalledTimes(1);
  button.dispatchEvent(new MouseEvent("mouseup"));
  expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
  expect(fixture.injectMidi).toHaveBeenLastCalledWith(...released());
});

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

test("keyboard leaves typing and shortcuts alone, clamps octaves, and supports soft velocity", async () => {
  for (const tag of ["input", "textarea", "select", "div"]) {
    const target = document.createElement(tag);
    if (tag === "div") target.contentEditable = "true";
    root.append(target);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  }
  key("keydown", "a", { ctrlKey: true });
  key("keydown", "a", { metaKey: true });
  key("keydown", "a", { altKey: true });
  key("keydown", "q");
  expect(fixture.injectMidi).not.toHaveBeenCalled();
  for (let i = 0; i < 12; i++) key("keydown", "z");
  await nextTick();
  key("keydown", "a", { shiftKey: true });
  key("keydown", "a");
  key("keyup", "a");
  expect(fixture.injectMidi.mock.calls[0]).toEqual([
    "n1.in",
    { type: "noteOn", channel: 0, note: 0, velocity: 40 },
  ]);
  expect(fixture.injectMidi).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 12; i++) key("keydown", "x");
  await nextTick();
  expect(root.querySelectorAll(".key-white, .key-black")).toHaveLength(20);
  key("keydown", "a");
  key("keyup", "a");
  expect(fixture.injectMidi.mock.calls[2]![1].note).toBe(108);
  root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
  key("keyup", "s");
  expect(fixture.injectMidi.mock.calls[4]![1].note).toBe(110);
});

test("mouse key leave and release send one noteOff, and empty routing ignores controller sends", async () => {
  const button = root.querySelector<HTMLButtonElement>(".key-white")!;
  button.dispatchEvent(new MouseEvent("mousedown"));
  button.dispatchEvent(new MouseEvent("mousedown"));
  button.dispatchEvent(new MouseEvent("mouseleave"));
  button.dispatchEvent(new MouseEvent("mouseleave"));
  button.dispatchEvent(new MouseEvent("mouseup"));
  expect(fixture.injectMidi.mock.calls).toEqual([
    ["n1.in", { type: "noteOn", channel: 0, note: 60, velocity: 96 }],
    released(),
  ]);
  const black = root.querySelector<HTMLButtonElement>(".key-black")!;
  black.dispatchEvent(new MouseEvent("mousedown"));
  black.dispatchEvent(new MouseEvent("mouseup"));
  expect(fixture.injectMidi.mock.calls[3]![1]).toMatchObject({ type: "noteOff", note: 61 });
  ports.value = [];
  await nextTick();
  root.querySelector<HTMLButtonElement>(".panic-btn")!.click();
  root.querySelector<HTMLButtonElement>(".ctrl-row-send")!.click();
  expect(fixture.injectMidi).toHaveBeenCalledTimes(4);
});

test("controller inputs send typed MIDI and pitch bend springs back on release", async () => {
  const sliders = [...root.querySelectorAll<HTMLElement>(".range-slider")];
  for (const slider of sliders) {
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  }
  sliders[0]!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 100 }));
  await nextTick();
  key("keydown");
  key("keyup");
  expect(fixture.injectMidi.mock.calls[0]![1].velocity).toBe(127);
  const inputs = root.querySelectorAll<HTMLInputElement>(".ctrl-row-aux input");
  inputs[0]!.value = "99";
  inputs[0]!.dispatchEvent(new Event("input"));
  await nextTick();
  expect(root.querySelector(".ctrl-row-aux-hint")).toBeNull();
  sliders[1]!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 100 }));
  await nextTick();
  expect(fixture.injectMidi).toHaveBeenLastCalledWith("n1.in", {
    type: "cc",
    channel: 0,
    controller: 99,
    value: 127,
  });
  sliders[2]!.dispatchEvent(new PointerEvent("pointerup"));
  await nextTick();
  expect(fixture.injectMidi).toHaveBeenCalledTimes(3);
  sliders[2]!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 100 }));
  await nextTick();
  expect(fixture.injectMidi).toHaveBeenLastCalledWith("n1.in", {
    type: "pitchBend",
    channel: 0,
    value: 8191,
  });
  sliders[2]!.dispatchEvent(new PointerEvent("pointerup"));
  await nextTick();
  expect(fixture.injectMidi).toHaveBeenLastCalledWith("n1.in", {
    type: "pitchBend",
    channel: 0,
    value: 0,
  });
  sliders[3]!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 100 }));
  await nextTick();
  expect(fixture.injectMidi).toHaveBeenLastCalledWith("n1.in", {
    type: "channelPressure",
    channel: 0,
    pressure: 127,
  });
  inputs[1]!.value = "7";
  inputs[1]!.dispatchEvent(new Event("input"));
  await nextTick();
  root.querySelector<HTMLButtonElement>(".ctrl-row-send")!.click();
  expect(fixture.injectMidi).toHaveBeenLastCalledWith("n1.in", {
    type: "programChange",
    channel: 0,
    program: 7,
  });
});

test("event log formats every MIDI variant, toggles directions and shows overflow", async () => {
  const events: MidiEvent[] = [
    { type: "noteOn", channel: 1, note: 60, velocity: 96 },
    { type: "noteOff", channel: 1, note: 60, velocity: 0 },
    { type: "cc", channel: 1, controller: 2, value: 3 },
    { type: "pitchBend", channel: 1, value: -100 },
    { type: "programChange", channel: 1, program: 7 },
    { type: "channelPressure", channel: 1, pressure: 5 },
    { type: "aftertouch", channel: 1, note: 61, pressure: 4 },
    { type: "systemRealtime", status: 0xf8 },
    { type: "sysex", data: [0xf0, 1, 0xf7] },
  ];
  log.value = events.map((event, id) => ({
    id,
    ts: 123456,
    portKey: "n1.in",
    direction: id % 2 ? "out" : "inject",
    event,
  }));
  overflow.value = { "n1.in": 2 };
  await nextTick();
  expect(root.querySelectorAll(".log-row")).toHaveLength(9);
  for (const text of [
    "C4",
    "cc 2 · val 3",
    "val -100",
    "prog 7",
    "pressure 5",
    "C#4",
    "status 0xf8",
    "3 bytes",
    "2 dropped",
  ])
    expect(root.textContent).toContain(text);
  root.querySelector<HTMLButtonElement>(".chip-out")!.click();
  await nextTick();
  expect(root.querySelectorAll(".log-row")).toHaveLength(5);
  root.querySelector<HTMLButtonElement>(".chip-out")!.click();
  await nextTick();
  expect(root.querySelectorAll(".log-row")).toHaveLength(9);
});

test.each([0, 108])("every PC key stays in MIDI range at octave boundary %s", async (base) => {
  for (let i = 0; i < 12; i++) key("keydown", base === 0 ? "z" : "x");
  await nextTick();
  const mapping = {
    a: 0,
    s: 2,
    d: 4,
    f: 5,
    g: 7,
    h: 9,
    j: 11,
    k: 12,
    l: 14,
    w: 1,
    e: 3,
    t: 6,
    y: 8,
    u: 10,
    o: 13,
    p: 15,
  };
  for (const [physical, offset] of Object.entries(mapping)) {
    key("keydown", physical);
    key("keyup", physical);
    expect(fixture.injectMidi.mock.calls.at(-2)).toEqual([
      "n1.in",
      { type: "noteOn", channel: 0, note: base + offset, velocity: 96 },
    ]);
    expect(fixture.injectMidi.mock.calls.at(-1)).toEqual([
      "n1.in",
      { type: "noteOff", channel: 0, note: base + offset, velocity: 0 },
    ]);
  }
  expect(fixture.injectMidi).toHaveBeenCalledTimes(32);
  expect(
    [...root.querySelectorAll(".key-pc-label")].map((el) => el.textContent!.trim()).sort(),
  ).toEqual(
    Object.keys(mapping)
      .map((physical) => physical.toUpperCase())
      .sort(),
  );
});

async function sendController(controller: number, value: number): Promise<void> {
  const input = root.querySelector<HTMLInputElement>(".ctrl-row-aux input")!;
  input.value = String(controller);
  input.dispatchEvent(new Event("input"));
  await nextTick();
  const slider = root.querySelectorAll<HTMLElement>(".range-slider")[1]!;
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 127 } as DOMRect);
  slider.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: value }));
  slider.dispatchEvent(new PointerEvent("pointerup"));
  await nextTick();
}

for (const controller of [64, 66, 69]) {
  test.each(["channel", "target", "unmount", "panic"])(
    `CC${controller} %s releases only the pedal engaged by the current route after key release`,
    async (reason) => {
      await sendController(controller, 127);
      key("keydown");
      key("keyup");
      if (reason === "channel") {
        const input = root.querySelector<HTMLInputElement>(".inject-routing input")!;
        input.value = "1";
        input.dispatchEvent(new Event("input"));
        await nextTick();
      } else if (reason === "target") {
        const select = root.querySelector<HTMLSelectElement>(".inject-routing select")!;
        select.value = "n2.in";
        select.dispatchEvent(new Event("change"));
        await nextTick();
      } else if (reason === "unmount") {
        app!.unmount();
        app = undefined;
      } else root.querySelector<HTMLButtonElement>(".panic-btn")!.click();
      expect(
        fixture.injectMidi.mock.calls.filter(
          ([, event]) => event.type === "cc" && event.controller === controller,
        ),
      ).toEqual([
        ["n1.in", { type: "cc", channel: 0, controller, value: 127 }],
        ["n1.in", { type: "cc", channel: 0, controller, value: 0 }],
      ]);
    },
  );

  test.each(["pedal up", "controller reset"])(
    `CC${controller} %s clears the route pedal latch before cleanup`,
    async (reason) => {
      await sendController(controller, 127);
      await sendController(controller, 64);
      if (reason === "pedal up") await sendController(controller, 63);
      else await sendController(121, 0);
      const count = fixture.injectMidi.mock.calls.length;
      app!.unmount();
      app = undefined;
      expect(fixture.injectMidi).toHaveBeenCalledTimes(count);
    },
  );
}

test("combined route pedals release independently", async () => {
  await sendController(64, 127);
  await sendController(66, 126);
  await sendController(69, 125);
  await sendController(64, 63);
  fixture.injectMidi.mockClear();
  app!.unmount();
  app = undefined;
  expect(fixture.injectMidi.mock.calls).toEqual(
    [66, 69].map((controller) => ["n1.in", { type: "cc", channel: 0, controller, value: 0 }]),
  );
});
