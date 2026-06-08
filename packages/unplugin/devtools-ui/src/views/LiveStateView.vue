<script setup lang="ts">
import { type ComponentPublicInstance, computed, onMounted, onUnmounted, ref } from "vue";

import {
  type LiveBuffer,
  type LiveScalar,
  type LiveSlotType,
  useLiveState,
} from "../composables/useLiveState";

const live = useLiveState();

// ── scalars ────────────────────────────────────────────────────────────────
// bool → on/off, i64 → text (decimal string, not charted), other numeric types
// → value + history sparkline.
const isBool = (s: LiveScalar): boolean => s.type === "bool";
const isCharted = (s: LiveScalar): boolean => s.type !== "bool" && s.type !== "i64";

const formatValue = (value: number | boolean | string, type: LiveSlotType): string => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value; // i64 decimal string
  if (type === "f32" || type === "f64") return value.toFixed(3);
  return String(value);
};

// ── buffers ──────────────────────────────────────────────────────────────--
type BufferRepr = "waveform" | "bar" | "grid" | "hex" | "list";
const BUFFER_OPTIONS: Record<LiveSlotType, BufferRepr[]> = {
  f32: ["waveform", "bar", "list"],
  f64: ["waveform", "bar", "list"],
  i32: ["bar", "waveform", "list"],
  i64: ["bar", "waveform", "list"],
  bool: ["grid", "list"],
  u8: ["hex", "bar", "list"],
};
const REPR_LABELS: Record<BufferRepr, string> = {
  waveform: "Waveform",
  bar: "Bar chart",
  grid: "Grid",
  hex: "Hex dump",
  list: "List",
};
const reprByKey = ref<Record<string, BufferRepr>>({});
const bufKey = (nodeId: string, name: string): string => `${nodeId}.${name}`;
const optionsFor = (b: LiveBuffer): BufferRepr[] => BUFFER_OPTIONS[b.type];
const reprFor = (nodeId: string, b: LiveBuffer): BufferRepr =>
  reprByKey.value[bufKey(nodeId, b.name)] ?? optionsFor(b)[0]!;
const setRepr = (nodeId: string, b: LiveBuffer, repr: BufferRepr): void => {
  reprByKey.value[bufKey(nodeId, b.name)] = repr;
};

const formatHex = (data: number[]): string =>
  data.map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase()).join(" ");

const formatList = (data: number[]): string => {
  const fmt = data.map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(3)));
  if (fmt.length <= 16) return `[${fmt.join(", ")}]`;
  return `[${fmt.slice(0, 16).join(", ")}, … ${fmt.length - 16} more]`;
};

// ── canvas drawing ─────────────────────────────────────────────────────────

const sizeCanvas = (
  canvas: HTMLCanvasElement,
  fallbackH: number,
): CanvasRenderingContext2D | null => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || fallbackH;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
};

const drawSparkline = (canvas: HTMLCanvasElement, history: readonly number[]): void => {
  const ctx = sizeCanvas(canvas, 24);
  if (!ctx || history.length < 2) return;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 24;
  let min = history[0]!;
  let max = history[0]!;
  for (const v of history) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  ctx.strokeStyle = "#fffaf0";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (history.length - 1)) * w;
    const y = h - 2 - ((history[i]! - min) / range) * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

const drawWaveform = (canvas: HTMLCanvasElement, data: number[]): void => {
  const ctx = sizeCanvas(canvas, 80);
  if (!ctx) return;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 80;
  ctx.strokeStyle = "rgba(255, 250, 240, 0.18)";
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  if (data.length === 0) return;
  let span = 1;
  for (const v of data) span = Math.max(span, Math.abs(v));
  ctx.strokeStyle = "#fffaf0";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = h / 2 - (data[i]! / span) * (h / 2 - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

const drawBars = (canvas: HTMLCanvasElement, data: number[]): void => {
  const ctx = sizeCanvas(canvas, 60);
  if (!ctx || data.length === 0) return;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 60;
  let min = data[0]!;
  let max = data[0]!;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const baseline = min < 0 ? 0 : min;
  const span = Math.max(Math.abs(max - baseline), Math.abs(min - baseline), 1);
  const cellW = w / data.length;
  const barW = Math.max(1, cellW - 2);
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    const barH = ((v - baseline) / span) * (h - 4);
    ctx.fillStyle = v >= baseline ? "#fffaf0" : "#ffb4ab";
    ctx.fillRect(i * cellW + 1, h - 2 - barH, barW, Math.max(1, barH));
  }
};

// ── canvas refs + redraw loop ────────────────────────────────────────────---

type TemplateRefEl = Element | ComponentPublicInstance | null;
const asCanvas = (el: TemplateRefEl): HTMLCanvasElement | null =>
  el instanceof HTMLCanvasElement ? el : null;
const sparklineRefs = ref<Record<string, HTMLCanvasElement | null>>({});
const waveformRefs = ref<Record<string, HTMLCanvasElement | null>>({});
const barRefs = ref<Record<string, HTMLCanvasElement | null>>({});
const setSparklineRef = (key: string) => (el: TemplateRefEl) => {
  sparklineRefs.value[key] = asCanvas(el);
};
const setWaveformRef = (key: string) => (el: TemplateRefEl) => {
  waveformRefs.value[key] = asCanvas(el);
};
const setBarRef = (key: string) => (el: TemplateRefEl) => {
  barRefs.value[key] = asCanvas(el);
};

const redraw = (): void => {
  for (const node of live.nodes.value) {
    for (const s of node.scalars) {
      if (!isCharted(s)) continue;
      const c = sparklineRefs.value[bufKey(node.id, s.name)];
      if (c) drawSparkline(c, live.getHistory(node.id, s.name));
    }
    for (const b of node.buffers) {
      const key = bufKey(node.id, b.name);
      const repr = reprFor(node.id, b);
      if (repr === "waveform") {
        const c = waveformRefs.value[key];
        if (c) drawWaveform(c, b.data);
      } else if (repr === "bar") {
        const c = barRefs.value[key];
        if (c) drawBars(c, b.data);
      }
    }
  }
};

let rafId: number | null = null;
const loop = (): void => {
  redraw();
  rafId = requestAnimationFrame(loop);
};
onMounted(() => {
  rafId = requestAnimationFrame(loop);
});
onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
});

const isEmpty = computed(() => live.nodes.value.length === 0);
</script>

<template>
  <div class="live-state-view">
    <header class="view-header">
      <div class="view-title">Live state</div>
      <div class="view-meta">
        <span class="u-pill u-pill--accent">{{ live.nodes.value.length }} nodes</span>
        <span class="u-pill">{{ live.totalScalars.value }} scalar slots</span>
        <span class="u-pill u-pill--accent">live</span>
      </div>
    </header>

    <div class="view-body">
      <div v-if="isEmpty" class="empty empty-page">
        <p>No live nodes yet.</p>
        <p class="empty-sub">
          Start the app's audio — every <code>createNode</code> appears here and its WASM state
          slots are polled in real time.
        </p>
      </div>

      <section v-for="node in live.nodes.value" :key="node.id" class="node-section">
        <header class="section-head">
          <span class="section-name">{{ node.displayName }}</span>
          <span class="u-pill u-pill--accent section-count">{{ node.scalars.length }} scalars</span>
          <span v-if="node.buffers.length" class="u-pill section-count"
            >{{ node.buffers.length }} buffers</span
          >
        </header>

        <div v-if="node.scalars.length === 0 && node.buffers.length === 0" class="empty">
          This node declares no state slots.
        </div>

        <ul v-else class="slot-list">
          <li v-for="s in node.scalars" :key="`s.${s.name}`" class="slot-row">
            <div class="slot-meta">
              <span class="slot-name mono">{{ s.name }}</span>
              <span class="u-pill slot-pill" :class="`kind-pill-${s.kind}`">{{ s.kind }}</span>
              <span class="slot-type mono">{{ s.type }}</span>
            </div>
            <div class="slot-value">
              <span class="slot-value-prefix mono">{{ formatValue(s.value, s.type) }}</span>
              <div class="slot-value-visual">
                <canvas
                  v-if="isCharted(s)"
                  :ref="setSparklineRef(bufKey(node.id, s.name))"
                  class="sparkline"
                ></canvas>
                <span
                  v-else-if="isBool(s)"
                  class="onoff-indicator"
                  :class="{ on: s.value === true }"
                >
                  <span class="onoff-dot"></span>
                  <span class="onoff-label">{{ s.value === true ? "on" : "off" }}</span>
                </span>
              </div>
            </div>
          </li>

          <li v-for="b in node.buffers" :key="`b.${b.name}`" class="slot-row slot-row--buffer">
            <div class="slot-meta">
              <span class="slot-name mono">{{ b.name }}</span>
              <span class="u-pill slot-pill kind-pill-buffer">buffer</span>
              <span class="slot-type mono">{{ b.type }}</span>
              <span class="slot-size mono">× {{ b.length }}</span>
              <span
                v-if="b.downsampled"
                class="slot-down mono"
                title="stride-downsampled for display"
              >
                ↓{{ b.data.length }}
              </span>
            </div>

            <div class="slot-repr">
              <select
                class="repr-select"
                :value="reprFor(node.id, b)"
                @change="
                  setRepr(node.id, b, ($event.target as HTMLSelectElement).value as BufferRepr)
                "
              >
                <option v-for="opt in optionsFor(b)" :key="opt" :value="opt">
                  {{ REPR_LABELS[opt] }}
                </option>
              </select>
            </div>

            <div class="slot-visual">
              <canvas
                v-if="reprFor(node.id, b) === 'waveform'"
                :ref="setWaveformRef(bufKey(node.id, b.name))"
                class="waveform"
              ></canvas>
              <canvas
                v-else-if="reprFor(node.id, b) === 'bar'"
                :ref="setBarRef(bufKey(node.id, b.name))"
                class="bar-chart"
              ></canvas>
              <div v-else-if="reprFor(node.id, b) === 'grid'" class="bool-grid">
                <span
                  v-for="(v, i) in b.data"
                  :key="i"
                  class="bool-cell"
                  :class="{ on: v !== 0 }"
                ></span>
              </div>
              <span v-else-if="reprFor(node.id, b) === 'hex'" class="hex-dump mono">{{
                formatHex(b.data)
              }}</span>
              <span v-else class="list-dump mono">{{ formatList(b.data) }}</span>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.live-state-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 24px 20px 18px;
  border-bottom: 1px solid var(--u-border);
  background: var(--u-bg-elev-1);
}

.view-title {
  font-family: var(--u-headline);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--u-text);
}

.view-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.view-body {
  flex: 1;
  overflow: auto;
  padding: 14px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.node-section {
  container-type: inline-size;
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 12px 14px 12px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px 10px;
  border-bottom: 1px solid var(--u-border);
  margin-bottom: 10px;
}

.section-name {
  font-family: var(--u-headline);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--u-text);
  margin-right: auto;
  overflow-wrap: anywhere;
}

.empty {
  padding: 10px 6px;
  color: var(--u-text-dim);
  font-size: 11.5px;
}

.empty code {
  background: var(--u-bg-elev-3);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--u-mono);
}

.empty-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
  padding: 48px 20px;
}

.empty-page p {
  margin: 0;
  font-size: 13px;
}

.empty-sub {
  max-width: 380px;
  font-size: 11.5px;
  line-height: 1.5;
}

.slot-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.slot-row {
  display: grid;
  grid-template-columns: minmax(220px, auto) minmax(160px, 1fr);
  align-items: center;
  gap: 12px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--u-border);
}

.slot-row--buffer {
  grid-template-columns: minmax(220px, auto) 130px minmax(160px, 1fr);
  align-items: start;
}

.slot-row:last-child {
  border-bottom: 0;
}

@container (max-width: 600px) {
  .slot-row,
  .slot-row--buffer {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
}

.slot-meta {
  display: grid;
  grid-template-columns: 150px 70px 36px auto auto;
  align-items: center;
  column-gap: 10px;
  overflow: hidden;
}

.slot-name {
  font-size: 12px;
  color: var(--u-text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot-pill {
  justify-self: start;
}

.kind-pill-param {
  color: var(--u-accent);
}

.slot-type,
.slot-size {
  font-size: 10.5px;
  color: var(--u-text-dim);
}

.slot-down {
  font-size: 10px;
  color: var(--u-text-muted);
}

.slot-value {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  align-items: center;
  column-gap: 8px;
  min-width: 0;
}

.slot-value-prefix {
  font-size: 12px;
  color: var(--u-text);
  text-align: right;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.slot-value-visual {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.repr-select {
  width: 100%;
  padding: 3px 6px;
  background: var(--u-bg-elev-2);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  color: var(--u-text);
  font-size: 11.5px;
  font-family: var(--u-sans);
  cursor: pointer;
}

.repr-select:hover {
  border-color: var(--u-border-strong);
}

.slot-visual {
  display: flex;
  align-items: center;
  min-width: 0;
}

/* min-width: 0 lets a canvas shrink below its 300px intrinsic width. */
.sparkline {
  flex: 1;
  min-width: 0;
  height: 24px;
  background: var(--u-bg);
  border-radius: 3px;
}

.waveform {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 72px;
  background-color: var(--u-bg);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
}

.bar-chart {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 56px;
  background-color: var(--u-bg);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
}

.onoff-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  background: var(--u-bg-elev-3);
  border-radius: 999px;
  color: var(--u-text-dim);
  font-size: 11.5px;
}

.onoff-indicator.on {
  background: var(--u-bg-elev-4);
  color: var(--u-text);
}

.onoff-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--u-text-dim);
}

.onoff-indicator.on .onoff-dot {
  background: var(--u-success);
}

.onoff-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  font-size: 10.5px;
}

.bool-grid {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.bool-cell {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  background: var(--u-bg-elev-3);
  border: 1px solid var(--u-border);
}

.bool-cell.on {
  background: var(--u-success);
  border-color: var(--u-success);
}

.hex-dump,
.list-dump {
  font-size: 11px;
  line-height: 1.5;
  color: var(--u-text-muted);
  word-break: break-all;
}

.slot-row--buffer .slot-name {
  color: var(--u-text-muted);
}
</style>
