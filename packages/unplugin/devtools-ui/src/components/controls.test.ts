import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { type App, createApp, h, nextTick, reactive } from "vue";

import PortChannelView from "./PortChannelView.vue";
import RangeSlider from "./RangeSlider.vue";
import UnworkletNode from "./UnworkletNode.vue";

const signal = vi.hoisted(() => ({
  frame: undefined as { time: number[]; freq: number[]; rms: number; peak: number } | undefined,
}));
vi.mock("../composables/useLiveSignals", () => ({
  useLiveSignals: () => ({ getFrame: () => signal.frame }),
}));
vi.mock("@vue-flow/core", () => ({
  Position: { Left: "left", Right: "right" },
  Handle: { render: () => null },
}));
const apps: App[] = [];
let root: HTMLDivElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("slider clamps values, handles zero-width geometry and releases captured pointers", async () => {
  const values: number[] = [];
  const release = vi.fn();
  const props = reactive({ modelValue: 0, min: 0, max: 100, centerOrigin: false });
  const app = createApp({
    render: () =>
      h(RangeSlider, {
        ...props,
        "onUpdate:modelValue": (v: number) => values.push(v),
        onRelease: release,
      }),
  });
  apps.push(app);
  app.mount(root);
  const track = root.querySelector<HTMLElement>(".range-slider")!;
  const rect = { left: 10, width: 100 };
  vi.spyOn(track, "getBoundingClientRect").mockImplementation(() => rect as DOMRect);
  const capture = vi.fn();
  const releaseCapture = vi.fn();
  Object.assign(track, {
    setPointerCapture: capture,
    hasPointerCapture: () => true,
    releasePointerCapture: releaseCapture,
  });
  const pointer = (type: string, options: PointerEventInit) =>
    track.dispatchEvent(new PointerEvent(type, { pointerId: 7, ...options }));
  pointer("pointerdown", { button: 2, clientX: 60 });
  expect(values).toEqual([]);
  pointer("pointerdown", { button: 0, clientX: 60 });
  expect(values).toEqual([50]);
  expect(capture).toHaveBeenCalledWith(7);
  pointer("pointermove", { buttons: 0, clientX: 90 });
  expect(values).toEqual([50]);
  pointer("pointermove", { buttons: 1, clientX: -20 });
  pointer("pointermove", { buttons: 1, clientX: 999 });
  expect(values).toEqual([50, 0, 100]);
  capture.mockImplementation(() => {
    throw new Error("Synthetic pointer");
  });
  pointer("pointerdown", { button: 0, clientX: 35 });
  expect(values.at(-1)).toBe(25);
  pointer("pointerup", {});
  expect(releaseCapture).toHaveBeenCalledWith(7);
  expect(release).toHaveBeenCalledOnce();
  Object.assign(track, { hasPointerCapture: () => false });
  pointer("pointerup", {});
  expect(releaseCapture).toHaveBeenCalledOnce();
  Object.assign(track, { hasPointerCapture: undefined });
  pointer("pointerup", {});
  expect(release).toHaveBeenCalledTimes(3);
  props.modelValue = 35;
  rect.width = 0;
  await nextTick();
  pointer("pointerdown", { button: 0 });
  expect(values.at(-1)).toBe(35);
  props.centerOrigin = true;
  props.modelValue = 25;
  await nextTick();
  expect(root.querySelector<HTMLElement>(".range-slider-fill")!.style.width).toBe("25%");
  expect(root.querySelector<HTMLElement>(".range-slider-fill")!.style.left).toBe("25%");
  props.modelValue = 75;
  await nextTick();
  expect(root.querySelector<HTMLElement>(".range-slider-fill")!.style.left).toBe("50%");
  props.min = props.max;
  await nextTick();
  expect(root.querySelector<HTMLElement>(".range-slider-thumb")!.style.left).toBe("0%");
  expect(root.querySelector<HTMLElement>(".range-slider-fill")!.style.width).toBe("50%");
  const sent = [...values];
  app.unmount();
  apps.pop();
  pointer("pointerdown", { button: 0, clientX: 50 });
  expect(values).toEqual(sent);
});

test("graph node shows identity, selection and optional diagnostics", async () => {
  const props = reactive({
    data: {
      kind: "unworklet",
      label: "synth",
      audioNodeType: "AudioWorkletNode",
      errorCount: 0,
      status: "ok",
    },
    selected: false,
  });
  const app = createApp({ render: () => h(UnworkletNode, props) });
  apps.push(app);
  app.mount(root);
  expect(root.querySelector(".uw-node-name")!.textContent).toBe("synth");
  expect(root.querySelector(".uw-node-badge")).toBeNull();
  props.data.errorCount = 2;
  props.selected = true;
  await nextTick();
  expect(root.querySelector(".uw-node-badge")!.textContent).toBe("2");
  expect(root.querySelector(".uw-node")!.classList.contains("selected")).toBe(true);
});

test("port scope draws polylines and min/max envelopes, updates decibel meters and scrolls spectra", () => {
  let frame!: FrameRequestCallback;
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 9;
  });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  let width = 4;
  let height = 0;
  let available = true;
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    getImageData: vi.fn(() => ({})),
    putImageData: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
    available ? (ctx as unknown as CanvasRenderingContext2D) : null,
  );
  signal.frame = undefined;
  const app = createApp(PortChannelView, { nodeId: "n1", portName: "out" });
  apps.push(app);
  app.mount(root);
  frame(0);
  expect(root.querySelector(".level-label")!.textContent).toBe("mono rms -∞ · peak -∞ dBFS");
  signal.frame = { time: [-2, 2, 0], freq: [-1, 0.5, 2], rms: 0.5, peak: 2 };
  frame(1);
  expect(ctx.lineTo).toHaveBeenCalled();
  expect(ctx.fillRect).toHaveBeenCalledTimes(3);
  expect(root.querySelector<HTMLElement>(".level-peak")!.style.left).toBe("100.0%");
  expect(root.querySelector(".level-label")!.textContent).toContain("rms -6.0");
  signal.frame = { time: [1, -1, 0, 0.5, -0.5, 0, 0, 1, -1], freq: [], rms: 0.00001, peak: 0 };
  frame(2);
  expect(ctx.moveTo.mock.calls.some(([x]) => x === 0.5)).toBe(true);
  expect(root.querySelector<HTMLElement>(".level-fill")!.style.width).toBe("0.0%");
  height = 80;
  width = 8;
  vi.stubGlobal("devicePixelRatio", 2);
  frame(3);
  expect(root.querySelector("canvas")!.height).toBe(160);
  vi.stubGlobal("devicePixelRatio", 0);
  available = false;
  frame(4);
  expect(root.querySelector(".level-label")!.textContent).toContain("rms -100.0");
  app.unmount();
  apps.pop();
  expect(cancel).toHaveBeenCalledWith(9);
});

test("mono downmix labels persist through frames, port changes and reconnects", async () => {
  let tick!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    tick = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const props = reactive({ nodeId: "n1", portName: "stereo" });
  const app = createApp({ render: () => h(PortChannelView, props) });
  apps.push(app);
  app.mount(root);
  const labels = () => {
    expect(root.querySelector(".measurement-label")!.textContent).toBe("Mono downmix");
    expect(root.querySelector(".waveform-canvas")!.getAttribute("aria-label")).toBe(
      "Mono downmix waveform",
    );
    expect(root.querySelector(".spectrogram-canvas")!.getAttribute("aria-label")).toBe(
      "Mono downmix spectrogram",
    );
    expect(root.querySelector(".level-label")!.textContent).toContain("mono rms");
  };
  labels();
  for (const frame of [
    { time: [0], freq: [0], rms: 0, peak: 0 },
    { time: [0.5], freq: [0.5], rms: 0.5, peak: 0.5 },
    undefined,
  ]) {
    signal.frame = frame;
    tick(0);
    labels();
  }
  props.portName = "mono";
  await nextTick();
  tick(1);
  labels();
  props.nodeId = "reconnected";
  signal.frame = { time: [0.25], freq: [0.25], rms: 0.25, peak: 0.25 };
  await nextTick();
  tick(2);
  labels();
  expect(root.querySelector(".level-label")!.textContent).toContain(
    "mono rms -12.0 · peak -12.0 dBFS",
  );
});
