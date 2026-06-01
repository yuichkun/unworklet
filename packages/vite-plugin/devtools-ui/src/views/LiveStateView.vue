<script setup lang="ts">
import { type ComponentPublicInstance, computed, onMounted, onUnmounted, ref } from "vue";

import { type LiveScalar, useLiveState } from "../composables/useLiveState";

const live = useLiveState();

// Scalar representation: bool → on/off, i64 → text (decimal string, not charted),
// every other numeric type → value + history sparkline.
const isBool = (s: LiveScalar): boolean => s.type === "bool";
const isCharted = (s: LiveScalar): boolean => s.type !== "bool" && s.type !== "i64";

const formatValue = (value: number | boolean | string, type: LiveScalar["type"]): string => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value; // i64 decimal string
  if (type === "f32" || type === "f64") return value.toFixed(3);
  return String(value);
};

// ── sparkline drawing ────────────────────────────────────────────────────

const drawSparkline = (
  canvas: HTMLCanvasElement,
  history: readonly number[],
  color: string,
): void => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 24;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (history.length < 2) return;
  let min = history[0]!;
  let max = history[0]!;
  for (const v of history) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (history.length - 1)) * w;
    const norm = (history[i]! - min) / range;
    const y = h - 2 - norm * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

const sparklineRefs = ref<Record<string, HTMLCanvasElement | null>>({});
type TemplateRefEl = Element | ComponentPublicInstance | null;
const asCanvas = (el: TemplateRefEl): HTMLCanvasElement | null =>
  el instanceof HTMLCanvasElement ? el : null;
const setSparklineRef = (key: string) => (el: TemplateRefEl) => {
  sparklineRefs.value[key] = asCanvas(el);
};
const slotKey = (nodeId: string, name: string): string => `${nodeId}.${name}`;

const redraw = (): void => {
  for (const node of live.nodes.value) {
    for (const s of node.scalars) {
      if (!isCharted(s)) continue;
      const c = sparklineRefs.value[slotKey(node.id, s.name)];
      if (c) drawSparkline(c, live.getHistory(node.id, s.name), "#fffaf0");
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
          <li v-for="s in node.scalars" :key="s.name" class="slot-row">
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
                  :ref="setSparklineRef(slotKey(node.id, s.name))"
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

          <li v-for="b in node.buffers" :key="b.name" class="slot-row slot-row--buffer">
            <div class="slot-meta">
              <span class="slot-name mono">{{ b.name }}</span>
              <span class="u-pill slot-pill kind-pill-buffer">buffer</span>
              <span class="slot-type mono">{{ b.type }}</span>
            </div>
            <div class="slot-value">
              <span class="slot-value-prefix mono">× {{ b.length }}</span>
              <div class="slot-value-visual">
                <span class="buffer-note">byte view — next wire</span>
              </div>
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

.slot-row:last-child {
  border-bottom: 0;
}

@container (max-width: 520px) {
  .slot-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
}

.slot-meta {
  display: grid;
  grid-template-columns: 150px 70px 36px;
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

.slot-type {
  font-size: 10.5px;
  color: var(--u-text-dim);
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

/* min-width: 0 lets the canvas shrink below its 300px intrinsic width. */
.sparkline {
  flex: 1;
  min-width: 0;
  height: 24px;
  background: var(--u-bg);
  border-radius: 3px;
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

.slot-row--buffer .slot-name {
  color: var(--u-text-muted);
}

.buffer-note {
  font-size: 10.5px;
  color: var(--u-text-dim);
  font-style: italic;
}
</style>
