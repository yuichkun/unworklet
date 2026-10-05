import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { type App, createApp, nextTick, ref } from "vue";

import { splitSlots } from "../../../src/devbridge";
import { type LiveNodeState } from "../composables/useLiveState";
import LiveStateView from "./LiveStateView.vue";

const fixture = vi.hoisted(() => ({ nodes: null as unknown }));
vi.mock("../composables/useLiveState", () => ({
  useLiveState: () => ({ nodes: fixture.nodes, totalScalars: ref(0), getHistory: () => [] }),
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
