import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { type App, createApp, nextTick, ref } from "vue";

import { splitSlots } from "../../../src/devbridge";
import { type LiveNodeState } from "../composables/useLiveState";
import LiveStateView from "./LiveStateView.vue";

const fixture = vi.hoisted(() => ({ nodes: null as unknown, history: [] as number[] }));
vi.mock("../composables/useLiveState", () => ({
  useLiveState: () => ({
    nodes: fixture.nodes,
    totalScalars: ref(0),
    getHistory: () => fixture.history,
  }),
}));
let app: App | undefined;
let root: HTMLDivElement;
let frame: FrameRequestCallback;
const nodes = ref<LiveNodeState[]>([]);
const fills: { x: number; y: number; w: number; h: number; color: string }[] = [];
const context = {
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  stroke: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  fillRect: (x: number, y: number, w: number, h: number) => {
    fills.push({ x, y, w, h, color: context.fillStyle });
  },
};
beforeEach(() => {
  fills.length = 0;
  nodes.value = [];
  fixture.history = [];
  fixture.nodes = nodes;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = (data: number[], extra: Record<string, unknown> = {}) => {
  nodes.value = [
    {
      id: "n1",
      displayName: "synth",
      scalars: [],
      buffers: [
        { name: "ticks", type: "i32", length: data.length, data, downsampled: false, ...extra },
      ],
    },
  ];
  app = createApp(LiveStateView);
  app.mount(root);
  frame(0);
};

test.each([
  [-10, 0, 10],
  [-10, -5, -1],
  [0, 5, 10],
  [0, 0, 0],
])("bar chart keeps signed values inside the canvas: %j", (...data) => {
  mount(data);
  expect(fills).toHaveLength(data.length);
  for (const bar of fills) {
    expect(bar.y).toBeGreaterThanOrEqual(0);
    expect(bar.y + bar.h).toBeLessThanOrEqual(60);
    expect(bar.h).toBeGreaterThanOrEqual(1);
  }
  const negative = data.findIndex((v) => v < 0);
  const positive = data.findIndex((v) => v > 0);
  if (negative >= 0 && positive >= 0) {
    expect(fills[negative]!.y).toBeGreaterThanOrEqual(fills[positive]!.y + fills[positive]!.h);
    expect(fills[negative]!.color).not.toBe(fills[positive]!.color);
  }
  if (data.every((v) => v < 0)) expect(fills[0]!.h).toBeGreaterThan(fills[1]!.h);
});

test("i64 list renders exact decimal values while charts disclose their approximation", async () => {
  const exactData = ["9007199254740993", "9223372036854775807"];
  const bytes = new Uint8Array(exactData.length * 8);
  const view = new DataView(bytes.buffer);
  exactData.forEach((value, i) => view.setBigInt64(i * 8, BigInt(value), true));
  const { buffers } = splitSlots(
    [{ name: "ticks", kind: "buffer", type: "i64", data: bytes }],
    512,
  );
  const payload = JSON.parse(JSON.stringify(buffers[0]!)) as (typeof buffers)[number];
  mount(payload.data, payload);
  expect(root.textContent).toContain("approximate");
  const select = root.querySelector<HTMLSelectElement>(".repr-select")!;
  select.value = "list";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  expect(root.querySelector(".list-dump")!.textContent).toBe(`[${exactData.join(", ")}]`);
  expect(root.textContent).not.toContain("approximate");
});

test("ordinary integer buffers keep their numeric list rendering", async () => {
  mount([1, 2, 3]);
  expect(root.textContent).not.toContain("approximate");
  const select = root.querySelector<HTMLSelectElement>(".repr-select")!;
  select.value = "list";
  select.dispatchEvent(new Event("change"));
  await nextTick();
  expect(root.querySelector(".list-dump")!.textContent).toBe("[1, 2, 3]");
});

test.each([1e308, Number.MIN_VALUE])(
  "finite f64 bars keep signed magnitudes visible at scale %s",
  async (magnitude) => {
    mount([-magnitude, 0, magnitude], { type: "f64" });
    const select = root.querySelector<HTMLSelectElement>(".repr-select")!;
    select.value = "bar";
    select.dispatchEvent(new Event("change"));
    await nextTick();
    frame(1);
    expect(fills).toHaveLength(3);
    for (const bar of fills) {
      expect(Number.isFinite(bar.y)).toBe(true);
      expect(Number.isFinite(bar.h)).toBe(true);
      expect(bar.y).toBeGreaterThanOrEqual(0);
      expect(bar.y + bar.h).toBeLessThanOrEqual(60);
    }
    expect(fills[0]!.h).toBeCloseTo(28);
    expect(fills[2]!.h).toBeCloseTo(28);
    expect(fills[0]!.y).toBeCloseTo(fills[2]!.y + fills[2]!.h);
  },
);

test("live state renders empty nodes, typed scalars, histories and all buffer representations", async () => {
  app = createApp(LiveStateView);
  app.mount(root);
  expect(root.textContent).toContain("No live");
  nodes.value = [{ id: "n1", displayName: "synth", scalars: [], buffers: [] }];
  await nextTick();
  expect(root.textContent).toContain("This node declares no state slots.");
  nodes.value[0]!.scalars = [
    { name: "gain", kind: "param", type: "f32", value: 0.25 },
    { name: "double", kind: "state", type: "f64", value: 0.75 },
    { name: "yes", kind: "state", type: "bool", value: true },
    { name: "no", kind: "state", type: "bool", value: false },
    { name: "ticks", kind: "state", type: "i64", value: "9007199254740993" },
    { name: "count", kind: "state", type: "i32", value: 3 },
  ];
  nodes.value[0]!.buffers = [
    {
      name: "float",
      type: "f32",
      length: 20,
      data: Array.from({ length: 20 }, (_, i) => i / 2),
      downsampled: true,
    },
    { name: "double", type: "f64", length: 0, data: [], downsampled: false },
    { name: "flags", type: "bool", length: 2, data: [0, 1], downsampled: false },
    { name: "bytes", type: "u8", length: 2, data: [0, 255], downsampled: false },
    { name: "empty", type: "i32", length: 0, data: [], downsampled: false },
  ];
  await nextTick();
  frame(1);
  for (const text of ["0.250", "0.750", "9007199254740993", "00 FF", "on", "off"])
    expect(root.textContent).toContain(text);
  expect(root.querySelectorAll(".bool-cell.on")).toHaveLength(1);
  expect(root.querySelector(".slot-down")!.textContent).toContain("20");
  fixture.history = [1];
  frame(2);
  fixture.history = [1, 2, 0, 1];
  frame(3);
  expect(context.lineTo).toHaveBeenCalled();
  fixture.history = [1, 1];
  frame(4);
  const selectors = root.querySelectorAll<HTMLSelectElement>(".repr-select");
  selectors[0]!.value = "list";
  selectors[0]!.dispatchEvent(new Event("change"));
  await nextTick();
  expect(root.querySelector(".list-dump")!.textContent).toContain("0.500");
  expect(root.querySelector(".list-dump")!.textContent).toContain("4 more");
  selectors[0]!.value = "bar";
  selectors[0]!.dispatchEvent(new Event("change"));
  await nextTick();
  frame(5);
  expect(fills.length).toBeGreaterThanOrEqual(20);
  selectors[2]!.value = "list";
  selectors[2]!.dispatchEvent(new Event("change"));
  await nextTick();
  expect([...root.querySelectorAll(".list-dump")].some((el) => el.textContent === "[0, 1]")).toBe(
    true,
  );
  selectors[0]!.value = "waveform";
  selectors[0]!.dispatchEvent(new Event("change"));
  await nextTick();
  nodes.value[0]!.buffers[0]!.data = [0];
  await nextTick();
  frame(6);
});

test("canvas resizes for display density and tolerates an unavailable 2D context", async () => {
  vi.stubGlobal("devicePixelRatio", 2);
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(120);
  vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(60);
  mount([1, 2]);
  expect(root.querySelector("canvas")!.width).toBe(240);
  frame(1);
  const selector = root.querySelector<HTMLSelectElement>(".repr-select")!;
  selector.value = "waveform";
  selector.dispatchEvent(new Event("change"));
  await nextTick();
  frame(2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const before = fills.length;
  frame(3);
  expect(fills).toHaveLength(before);
  selector.value = "bar";
  selector.dispatchEvent(new Event("change"));
  await nextTick();
  frame(4);
  expect(fills).toHaveLength(before);
  nodes.value[0]!.scalars = [{ name: "count", kind: "state", type: "i32", value: 1 }];
  fixture.history = [1, 2];
  await nextTick();
  frame(5);
  vi.stubGlobal("devicePixelRatio", 0);
  frame(6);
});
