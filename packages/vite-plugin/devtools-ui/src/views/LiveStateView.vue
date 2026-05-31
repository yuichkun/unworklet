<script setup lang="ts">
import { computed, type ComponentPublicInstance, onMounted, onUnmounted, ref, watch } from "vue";

import { useLiveStateMock } from "../composables/useLiveStateMock";
import {
  type AudioGraphNode,
  type PublishSlotMeta,
  useMockGraph,
} from "../composables/useMockGraph";

type ScalarRepr = "history-line" | "on-off" | "numeric";
type BufferRepr = "waveform" | "bar" | "grid" | "hex" | "list";
type Repr = ScalarRepr | BufferRepr;

const SCALAR_OPTIONS: Record<PublishSlotMeta["type"], ScalarRepr[]> = {
  f32: ["history-line", "numeric"],
  f64: ["history-line", "numeric"],
  i32: ["history-line", "numeric"],
  i64: ["history-line", "numeric"],
  bool: ["on-off", "history-line", "numeric"],
  u8: ["numeric", "history-line"],
};

const BUFFER_OPTIONS: Record<PublishSlotMeta["type"], BufferRepr[]> = {
  f32: ["waveform", "bar", "list"],
  f64: ["waveform", "bar", "list"],
  i32: ["bar", "waveform", "list"],
  i64: ["bar", "waveform", "list"],
  bool: ["grid", "list"],
  u8: ["hex", "bar", "list"],
};

const REPR_LABELS: Record<Repr, string> = {
  "history-line": "History line",
  "on-off": "On / off",
  numeric: "Numeric",
  waveform: "Waveform",
  bar: "Bar chart",
  grid: "Grid",
  hex: "Hex dump",
  list: "List",
};

const graph = useMockGraph();
const live = useLiveStateMock();

const unworkletNodes = computed<AudioGraphNode[]>(() =>
  graph.nodes.filter((n) => n.kind === "unworklet"),
);

const totalPublishCount = computed(() =>
  unworkletNodes.value.reduce((acc, n) => acc + graph.publishSlots(n.id).length, 0),
);

const reprByKey = ref<Record<string, Repr>>({});

const optionsFor = (slot: PublishSlotMeta): Repr[] =>
  slot.kind === "state" ? SCALAR_OPTIONS[slot.type] : BUFFER_OPTIONS[slot.type];

const defaultRepr = (slot: PublishSlotMeta): Repr => optionsFor(slot)[0]!;

const reprFor = (nodeId: string, slot: PublishSlotMeta): Repr => {
  const key = `${nodeId}.${slot.name}`;
  return reprByKey.value[key] ?? defaultRepr(slot);
};

const setRepr = (nodeId: string, slot: PublishSlotMeta, repr: Repr): void => {
  reprByKey.value[`${nodeId}.${slot.name}`] = repr;
};

const slotKey = (nodeId: string, slot: PublishSlotMeta): string => `${nodeId}.${slot.name}`;

const formatScalar = (value: number | boolean, type: PublishSlotMeta["type"]): string => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (type === "f32" || type === "f64") {
    return value.toFixed(3);
  }
  return String(value);
};

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

const drawWaveform = (canvas: HTMLCanvasElement, samples: Float32Array | Int32Array): void => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 80;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(168, 172, 184, 0.18)";
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (samples.length === 0) return;
  let min = samples[0]!;
  let max = samples[0]!;
  for (const v of samples) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(Math.abs(min), Math.abs(max), 1);

  ctx.strokeStyle = "#fffaf0";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * w;
    const norm = samples[i]! / span;
    const y = h / 2 - norm * (h / 2 - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

const drawBars = (
  canvas: HTMLCanvasElement,
  samples: Float32Array | Int32Array | Uint8Array,
): void => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 60;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (samples.length === 0) return;
  let min = Number(samples[0]!);
  let max = Number(samples[0]!);
  for (const v of samples) {
    const n = Number(v);
    if (n < min) min = n;
    if (n > max) max = n;
  }
  const baseline = min < 0 ? 0 : min;
  const span = Math.max(Math.abs(max - baseline), Math.abs(min - baseline), 1);

  const cellW = w / samples.length;
  const barW = Math.max(1, cellW - 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Number(samples[i]!);
    const norm = (v - baseline) / span;
    const barH = norm * (h - 4);
    const x = i * cellW + 1;
    const y = h - 2 - barH;
    ctx.fillStyle = v >= baseline ? "#fffaf0" : "#ffb4ab";
    ctx.fillRect(x, y, barW, Math.max(1, barH));
  }
};

const formatHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

const formatList = (samples: Float32Array | Int32Array | Uint8Array | boolean[]): string => {
  const arr = Array.from(samples as ArrayLike<number | boolean>);
  const formatted = arr.map((v) =>
    typeof v === "boolean" ? (v ? "1" : "0") : Number.isInteger(v) ? String(v) : v.toFixed(3),
  );
  if (formatted.length <= 16) return `[${formatted.join(", ")}]`;
  return `[${formatted.slice(0, 16).join(", ")}, … ${formatted.length - 16} more]`;
};

const sparklineRefs = ref<Record<string, HTMLCanvasElement | null>>({});
const waveformRefs = ref<Record<string, HTMLCanvasElement | null>>({});
const barRefs = ref<Record<string, HTMLCanvasElement | null>>({});

type TemplateRefEl = Element | ComponentPublicInstance | null;

const asCanvas = (el: TemplateRefEl): HTMLCanvasElement | null =>
  el instanceof HTMLCanvasElement ? el : null;

const setSparklineRef = (key: string) => (el: TemplateRefEl) => {
  sparklineRefs.value[key] = asCanvas(el);
};
const setWaveformRef = (key: string) => (el: TemplateRefEl) => {
  waveformRefs.value[key] = asCanvas(el);
};
const setBarRef = (key: string) => (el: TemplateRefEl) => {
  barRefs.value[key] = asCanvas(el);
};

const EMPTY_U8 = new Uint8Array();

const redraw = (): void => {
  for (const node of unworkletNodes.value) {
    for (const slot of graph.publishSlots(node.id)) {
      const key = slotKey(node.id, slot);
      const repr = reprFor(node.id, slot);
      if (slot.kind === "state") {
        if (repr === "history-line") {
          const c = sparklineRefs.value[key];
          if (c) {
            const hist = live.getSlotHistory(key);
            drawSparkline(c, hist, "#fffaf0");
          }
        }
      } else {
        const buf = live.getSlotBuffer(key);
        if (!buf) continue;
        if (repr === "waveform") {
          const c = waveformRefs.value[key];
          if (c && (buf instanceof Float32Array || buf instanceof Int32Array)) {
            drawWaveform(c, buf);
          }
        } else if (repr === "bar") {
          const c = barRefs.value[key];
          if (
            c &&
            (buf instanceof Float32Array || buf instanceof Int32Array || buf instanceof Uint8Array)
          ) {
            drawBars(c, buf);
          }
        }
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

watch(reprByKey, () => redraw(), { deep: true });
</script>

<template>
  <div class="live-state-view">
    <header class="view-header">
      <div class="view-title">Live state</div>
      <div class="view-meta">
        <span class="u-pill u-pill--accent">{{ unworkletNodes.length }} nodes</span>
        <span class="u-pill">{{ totalPublishCount }} publish slots</span>
      </div>
    </header>

    <div class="view-body">
      <section v-for="node in unworkletNodes" :key="node.id" class="node-section">
        <header class="section-head">
          <div class="section-name-cell">
            <span class="section-dot" :class="`status-${node.status}`"></span>
            <span class="section-name">{{ node.label }}</span>
          </div>
          <span class="u-pill section-pill">{{ node.audioNodeType }}</span>
          <span class="u-pill u-pill--accent section-count">
            {{ graph.publishSlots(node.id).length }} slots
          </span>
        </header>

        <div v-if="graph.publishSlots(node.id).length === 0" class="empty">
          This node declares no <code>publish</code> slots.
        </div>

        <ul v-else class="slot-list">
          <li v-for="slot in graph.publishSlots(node.id)" :key="slot.name" class="slot-row">
            <div class="slot-meta">
              <span class="slot-name mono">{{ slot.name }}</span>
              <span class="u-pill slot-pill" :class="`kind-pill-${slot.kind}`">{{
                slot.kind
              }}</span>
              <span class="slot-type mono">{{ slot.type }}</span>
              <span class="slot-size mono">
                <template v-if="slot.kind === 'buffer'">× {{ slot.size }}</template>
              </span>
              <span class="slot-rate mono">{{ slot.rateFps }} fps</span>
            </div>

            <div class="slot-repr">
              <select
                class="repr-select"
                :value="reprFor(node.id, slot)"
                @change="setRepr(node.id, slot, ($event.target as HTMLSelectElement).value as Repr)"
              >
                <option v-for="opt in optionsFor(slot)" :key="opt" :value="opt">
                  {{ REPR_LABELS[opt] }}
                </option>
              </select>
            </div>

            <div class="slot-value">
              <!-- Numeric prefix (fixed-width column 1) — only rendered for
                   state+history-line and state+numeric. Empty placeholder for
                   every other row, so column 2 (the visual) always starts at
                   the same x position. -->
              <span class="slot-value-prefix mono">
                <template
                  v-if="
                    slot.kind === 'state' &&
                    (reprFor(node.id, slot) === 'history-line' ||
                      reprFor(node.id, slot) === 'numeric')
                  "
                >
                  {{ formatScalar(live.getSlotScalar(slotKey(node.id, slot)) ?? 0, slot.type) }}
                </template>
              </span>

              <!-- Visual (column 2): sparkline / on-off / waveform / bar / grid / hex / list. -->
              <div class="slot-value-visual">
                <template v-if="slot.kind === 'state'">
                  <template v-if="reprFor(node.id, slot) === 'history-line'">
                    <canvas
                      :ref="setSparklineRef(slotKey(node.id, slot))"
                      class="sparkline"
                    ></canvas>
                  </template>
                  <template v-else-if="reprFor(node.id, slot) === 'on-off'">
                    <span
                      class="onoff-indicator"
                      :class="{ on: live.getSlotScalar(slotKey(node.id, slot)) === true }"
                    >
                      <span class="onoff-dot"></span>
                      <span class="onoff-label">
                        {{ live.getSlotScalar(slotKey(node.id, slot)) === true ? "on" : "off" }}
                      </span>
                    </span>
                  </template>
                </template>

                <template v-else>
                  <template v-if="reprFor(node.id, slot) === 'waveform'">
                    <canvas :ref="setWaveformRef(slotKey(node.id, slot))" class="waveform"></canvas>
                  </template>
                  <template v-else-if="reprFor(node.id, slot) === 'bar'">
                    <canvas :ref="setBarRef(slotKey(node.id, slot))" class="bar-chart"></canvas>
                  </template>
                  <template v-else-if="reprFor(node.id, slot) === 'grid'">
                    <div class="bool-grid">
                      <span
                        v-for="(v, i) in (live.getSlotBuffer(slotKey(node.id, slot)) ??
                          []) as boolean[]"
                        :key="i"
                        class="bool-cell"
                        :class="{ on: v }"
                      ></span>
                    </div>
                  </template>
                  <template v-else-if="reprFor(node.id, slot) === 'hex'">
                    <span class="hex-dump mono">
                      {{
                        formatHex(
                          (live.getSlotBuffer(slotKey(node.id, slot)) ?? EMPTY_U8) as Uint8Array,
                        )
                      }}
                    </span>
                  </template>
                  <template v-else>
                    <span class="list-dump mono">
                      {{ formatList(live.getSlotBuffer(slotKey(node.id, slot)) ?? EMPTY_U8) }}
                    </span>
                  </template>
                </template>
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
  /* horizontal scroll as a safety net at extreme narrow widths where nested
     grid layouts cant shrink further (= controllers grid in MidiView, etc). */
  overflow: auto;
  padding: 14px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.node-section {
  /* container queries below target the node-section's actual width so we
     can collapse the slot grid before it overflows the panel. */
  container-type: inline-size;
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 12px 14px 12px;
}

.section-head {
  display: grid;
  /* First two columns match .slot-meta's first two columns so the
     "AudioWorkletNode" pill in the section header lines up vertically with
     the per-row "state"/"buffer" pills below it. The trailing `auto` holds
     the count pill ("N slots"). */
  grid-template-columns: 130px 130px auto;
  align-items: center;
  column-gap: 10px;
  padding: 0 4px 10px;
  border-bottom: 1px solid var(--u-border);
  margin-bottom: 10px;
}

.section-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.section-pill {
  justify-self: start;
}

.section-count {
  justify-self: start;
}

.section-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.section-dot.status-ok {
  background: var(--u-success);
}

.section-dot.status-errors {
  background: var(--u-danger);
}

.section-dot.status-warning {
  background: var(--u-warn);
}

.section-name {
  font-family: var(--u-headline);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--u-text);
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
  /* slot-meta sizes to its grid content (= 130 + 130 + 36 + 56 + 56 + gaps),
     so the kind pill / type / size / rate columns are never clipped. */
  grid-template-columns: auto 140px minmax(160px, 1fr);
  align-items: center;
  gap: 12px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--u-border);
}

.slot-row:last-child {
  border-bottom: 0;
}

.slot-meta {
  display: grid;
  /* slot-name fixed at 130px so the kind pill ("state"/"buffer") sits at a
     stable x position across rows AND matches `.section-head`'s pill column.
     pill column is 130px to fit the longest audio-node type string
     ("AudioDestinationNode") in the section header above — the short
     "state"/"buffer" pills in slot rows just left-align inside it. */
  grid-template-columns: 130px 130px 36px 56px 56px;
  align-items: center;
  column-gap: 10px;
  overflow: hidden;
}

/* Slot-row at full width needs ~794px (slot-meta 428 + 140 select + 160 vis
   + gaps). Below ~760px the visualization column gets crushed — at ~580px
   we stack to vertical instead. Mid-range (~580-760px) we drop the size +
   rate columns so the visualization keeps breathing room. */
@container (max-width: 760px) {
  .slot-meta {
    grid-template-columns: minmax(0, 1fr) 130px 36px;
  }
  .slot-size,
  .slot-rate {
    display: none;
  }
}

@container (max-width: 580px) {
  .slot-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
  .slot-meta {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
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

.slot-type {
  font-size: 10.5px;
  color: var(--u-text-dim);
}

.slot-size {
  font-size: 10.5px;
  color: var(--u-text-dim);
}

.slot-rate {
  font-size: 10.5px;
  color: var(--u-text-dim);
  text-align: right;
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

.slot-value {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  align-items: center;
  column-gap: 8px;
  min-width: 0;
}

.slot-value-prefix {
  font-size: 12px;
  color: var(--u-text);
  text-align: right;
  min-width: 0;
}

.slot-value-visual {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* min-width: 0 is critical — <canvas> has an intrinsic width of 300px (the
   default `width` attribute), and flex children default to `min-width: auto`
   which honors that intrinsic floor. Without min-width: 0, `flex: 1` can't
   shrink the canvas below 300px and the row overflows its parent card at
   any viewport where the visual column is narrower than 300px. */
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
  height: 80px;
  background-color: var(--u-bg);
  background-image:
    linear-gradient(rgba(255, 250, 240, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 250, 240, 0.04) 1px, transparent 1px);
  background-size: 40px 40px;
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
}

.bar-chart {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 60px;
  background-color: var(--u-bg);
  background-image:
    linear-gradient(rgba(255, 250, 240, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 250, 240, 0.04) 1px, transparent 1px);
  background-size: 40px 40px;
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
  width: 22px;
  height: 22px;
  border-radius: 3px;
  background: var(--u-bg-elev-3);
  border: 1px solid var(--u-border);
}

.bool-cell.on {
  background: var(--u-success);
  border-color: var(--u-success);
}

.hex-dump {
  font-size: 11px;
  color: var(--u-text);
  background: var(--u-bg);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  padding: 6px 8px;
  letter-spacing: 0.04em;
  word-break: break-all;
  flex: 1;
}

.list-dump {
  font-size: 11px;
  color: var(--u-text-muted);
  background: var(--u-bg);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  padding: 6px 8px;
  word-break: break-all;
  flex: 1;
}

.kind-pill-state,
.kind-pill-buffer {
  background: var(--u-bg-elev-4);
  color: var(--u-text);
}
</style>
