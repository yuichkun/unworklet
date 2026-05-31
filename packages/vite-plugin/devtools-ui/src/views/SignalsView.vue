<script setup lang="ts">
import JSZip from "jszip";
import { computed, onMounted, onUnmounted, ref } from "vue";

import PortChannelView from "../components/PortChannelView.vue";
import { type OutputPort, portKey, useMockSignals } from "../composables/useMockSignals";
import { encodeWav, timestampLabel } from "../lib/wav";

type SubTab = "audio" | "latency" | "memory";

const TAB_LABELS: Record<SubTab, string> = {
  audio: "Audio",
  latency: "Latency",
  memory: "Memory",
};
const TAB_ORDER: SubTab[] = ["audio", "latency", "memory"];

const signals = useMockSignals();
const activeTab = ref<SubTab>("audio");

const portChecks = ref<Record<string, boolean>>(
  Object.fromEntries(signals.ports.value.map((p) => [portKey(p), true])),
);

type ConfirmedSnapshot = {
  channels: Float32Array[];
  durationS: number;
  ts: string;
  blobUrl: string;
};

const confirmed = ref<Record<string, ConfirmedSnapshot>>({});

const isChecked = (port: OutputPort): boolean => portChecks.value[portKey(port)] ?? false;
const toggleCheck = (port: OutputPort): void => {
  const k = portKey(port);
  portChecks.value[k] = !portChecks.value[k];
};

const recordPort = (port: OutputPort): void => {
  const channels = signals.captureRing(port);
  const wav = encodeWav(channels, signals.sampleRate);
  const blob = new Blob([wav], { type: "audio/wav" });
  const blobUrl = URL.createObjectURL(blob);

  const key = portKey(port);
  const prev = confirmed.value[key];
  if (prev) URL.revokeObjectURL(prev.blobUrl);

  confirmed.value[key] = {
    channels,
    durationS: channels[0]!.length / signals.sampleRate,
    ts: timestampLabel(),
    blobUrl,
  };
};

const downloadPortWav = (port: OutputPort): void => {
  const snap = confirmed.value[portKey(port)];
  if (!snap) return;
  const a = document.createElement("a");
  a.href = snap.blobUrl;
  a.download = `${port.nodeId}-${port.portName}-${snap.ts}.wav`;
  a.click();
};

const discardPort = (port: OutputPort): void => {
  const key = portKey(port);
  const snap = confirmed.value[key];
  if (!snap) return;
  URL.revokeObjectURL(snap.blobUrl);
  delete confirmed.value[key];
};

const recordAll = (): void => {
  for (const port of signals.ports.value) {
    if (!isChecked(port)) continue;
    recordPort(port);
  }
};

const downloadAllZip = async (): Promise<void> => {
  const entries = Object.entries(confirmed.value);
  if (entries.length === 0) return;
  const zip = new JSZip();
  const ts = timestampLabel();
  for (const [key, snap] of entries) {
    const wav = encodeWav(snap.channels, signals.sampleRate);
    zip.file(`${key}-${snap.ts}.wav`, wav);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `recordings-${ts}.zip`;
  a.click();
  URL.revokeObjectURL(url);
};

const confirmedCount = computed(() => Object.keys(confirmed.value).length);
const canDownloadZip = computed(() => confirmedCount.value > 0);

const totalLatencyMs = computed(() => signals.getLatencyStats(signals.latencyTotalKey).mean);

const latencyCanvasRef = ref<HTMLCanvasElement | null>(null);

const LATENCY_COLORS: Record<string, string> = {
  polysynth: "#82bfff",
  limiter: "#62d18a",
  reverb: "#c89cff",
  total: "#f1c560",
};

const drawLatencyChart = (): void => {
  const canvas = latencyCanvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 240;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  let observedMax = 0;
  for (const node of [...signals.latencyNodeIds, signals.latencyTotalKey]) {
    for (const v of signals.getLatencyHistory(node)) {
      if (v > observedMax) observedMax = v;
    }
  }
  const yMax = Math.max(signals.realtimeBudgetMs * 1.2, observedMax * 1.1, 1);
  const left = 44;
  const right = w - 12;
  const top = 12;
  const bottom = h - 22;
  const plotH = bottom - top;
  const plotW = right - left;

  ctx.fillStyle = "rgba(168, 172, 184, 0.6)";
  ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const y = bottom - (v / yMax) * plotH;
    ctx.fillText(`${v.toFixed(1)}`, 6, y + 3);
    ctx.strokeStyle = "rgba(168, 172, 184, 0.08)";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  const budgetY = bottom - (signals.realtimeBudgetMs / yMax) * plotH;
  ctx.strokeStyle = "#ff6363";
  ctx.fillStyle = "#ff6363";
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(left, budgetY);
  ctx.lineTo(right, budgetY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText(`budget ${signals.realtimeBudgetMs.toFixed(2)} ms`, left + 4, budgetY - 4);

  for (const node of [...signals.latencyNodeIds, signals.latencyTotalKey]) {
    const arr = signals.getLatencyHistory(node);
    if (arr.length < 2) continue;
    ctx.strokeStyle = LATENCY_COLORS[node] ?? "#82bfff";
    ctx.lineWidth = node === signals.latencyTotalKey ? 2 : 1.4;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = left + (i / (arr.length - 1)) * plotW;
      const v = arr[i]!;
      const y = bottom - (v / yMax) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};

// Audio-tab canvases (waveform + spectrogram) are now driven by PortChannelView
// instances themselves — each owns its rAF loop. This parent loop only services
// the latency chart, which still lives inline in this view.
let rafId: number | null = null;
const loop = (): void => {
  if (activeTab.value === "latency") {
    drawLatencyChart();
  }
  rafId = requestAnimationFrame(loop);
};

onMounted(() => {
  rafId = requestAnimationFrame(loop);
});
onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  for (const snap of Object.values(confirmed.value)) {
    URL.revokeObjectURL(snap.blobUrl);
  }
});

const memoryRollup = computed(() => signals.computeMemoryRollup());
const memoryTotalBytes = computed(() => memoryRollup.value.reduce((s, e) => s + e.bytes, 0));

const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatDuration = (s: number): string => {
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  return `${String(mm).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}`;
};

const memoryWarnRatio = computed(() => memoryTotalBytes.value / signals.memoryWarnBytes);
</script>

<template>
  <div class="signals-view">
    <header class="view-header">
      <div class="view-title">Signals &amp; performance</div>
      <div class="view-meta">
        <span class="u-pill">{{ signals.ports.value.length }} ports</span>
        <span class="u-pill">total latency {{ totalLatencyMs.toFixed(2) }} ms</span>
        <span class="u-pill">total memory {{ formatBytes(memoryTotalBytes) }}</span>
      </div>
    </header>

    <nav class="sub-tab-nav">
      <button
        v-for="t in TAB_ORDER"
        :key="t"
        class="sub-tab"
        :class="{ active: activeTab === t }"
        @click="activeTab = t"
      >
        {{ TAB_LABELS[t] }}
      </button>
    </nav>

    <div class="view-body">
      <section v-if="activeTab === 'audio'" class="audio-tab">
        <header class="audio-header">
          <div class="port-checks">
            <label v-for="port in signals.ports.value" :key="portKey(port)" class="port-check">
              <input type="checkbox" :checked="isChecked(port)" @change="toggleCheck(port)" />
              <span class="port-check-label mono">{{ portKey(port) }}</span>
            </label>
          </div>
          <div class="audio-header-actions">
            <button class="u-btn u-btn--primary" @click="recordAll">Capture all (zip)</button>
            <button
              class="u-btn"
              :disabled="!canDownloadZip"
              :title="canDownloadZip ? '' : 'Capture at least one port first'"
              @click="downloadAllZip"
            >
              Download zip
            </button>
          </div>
        </header>

        <div v-if="!signals.ports.value.some(isChecked)" class="audio-empty">
          No ports selected. Pick one above to start observing.
        </div>

        <div v-else class="audio-grid">
          <article
            v-for="port in signals.ports.value.filter(isChecked)"
            :key="portKey(port)"
            class="port-section"
            :class="{ captured: !!confirmed[portKey(port)] }"
          >
            <header class="port-head">
              <span class="port-head-name mono">{{ portKey(port) }}</span>
              <span class="port-head-meta mono">
                {{ port.channels }} ch · {{ signals.sampleRate }} Hz
              </span>
              <button class="u-btn u-btn--primary port-head-cta" @click="recordPort(port)">
                {{ confirmed[portKey(port)] ? "Re-capture" : "Capture" }}
              </button>
            </header>

            <div class="port-body">
              <!-- One PortChannelView per channel; today we render only ch 0,
                   but the loop trivially generalizes to all channels (= remove
                   the slice(0, 1)) once we expose a per-port channel picker. -->
              <PortChannelView
                v-for="ch in [0]"
                :key="`${portKey(port)}-${ch}`"
                :port="port"
                :channel-index="ch"
              />
            </div>

            <footer v-if="confirmed[portKey(port)]" class="port-captured">
              <div class="port-captured-row">
                <div class="port-captured-meta">
                  <span class="port-captured-tag mono">✓ Captured</span>
                  <span class="port-captured-time mono">
                    {{ formatDuration(confirmed[portKey(port)]!.durationS) }} ·
                    {{ confirmed[portKey(port)]!.ts }}
                  </span>
                </div>
                <button
                  class="icon-btn"
                  @click="downloadPortWav(port)"
                  title="Download as 16-bit PCM WAV"
                  aria-label="Download WAV"
                >
                  ↓
                </button>
                <button
                  class="icon-btn"
                  @click="discardPort(port)"
                  title="Discard capture"
                  aria-label="Discard capture"
                >
                  ×
                </button>
              </div>
              <audio
                :src="confirmed[portKey(port)]!.blobUrl"
                controls
                preload="metadata"
                class="captured-audio"
              ></audio>
            </footer>
          </article>
        </div>
      </section>

      <section v-else-if="activeTab === 'latency'" class="latency-tab">
        <div class="latency-stats">
          <article
            v-for="node in [...signals.latencyNodeIds, signals.latencyTotalKey]"
            :key="node"
            class="latency-stat-card"
          >
            <header class="latency-stat-head">
              <span
                class="latency-stat-dot"
                :style="{ background: LATENCY_COLORS[node] ?? '#82bfff' }"
              ></span>
              <span class="latency-stat-name mono">{{ node }}</span>
            </header>
            <div class="latency-stat-rows">
              <div class="latency-stat-row">
                <span class="latency-stat-key">P50</span>
                <span class="latency-stat-val mono">
                  {{ signals.getLatencyStats(node).p50.toFixed(2) }} ms
                </span>
              </div>
              <div class="latency-stat-row">
                <span class="latency-stat-key">P95</span>
                <span class="latency-stat-val mono">
                  {{ signals.getLatencyStats(node).p95.toFixed(2) }} ms
                </span>
              </div>
              <div class="latency-stat-row">
                <span class="latency-stat-key">P99</span>
                <span class="latency-stat-val mono">
                  {{ signals.getLatencyStats(node).p99.toFixed(2) }} ms
                </span>
              </div>
              <div class="latency-stat-row">
                <span class="latency-stat-key">Max</span>
                <span class="latency-stat-val mono">
                  {{ signals.getLatencyStats(node).max.toFixed(2) }} ms
                </span>
              </div>
            </div>
          </article>
        </div>

        <div class="latency-chart-block">
          <header class="canvas-head">
            <span class="canvas-title">Render quantum cost</span>
            <span class="canvas-meta mono">
              budget {{ signals.realtimeBudgetMs.toFixed(2) }} ms @ 128 / 48 kHz
            </span>
          </header>
          <canvas ref="latencyCanvasRef" class="latency-canvas"></canvas>
        </div>
      </section>

      <section v-else class="memory-tab">
        <header class="memory-summary">
          <div class="memory-total-row">
            <span class="memory-total-label">Total declared memory</span>
            <span class="memory-total-bytes mono">{{ formatBytes(memoryTotalBytes) }}</span>
          </div>
          <div class="memory-budget-track">
            <div
              class="memory-budget-fill"
              :style="{
                width: `${Math.max(0.1, Math.min(100, memoryWarnRatio * 100)).toFixed(2)}%`,
              }"
            ></div>
            <span class="memory-budget-line warn">
              <span class="memory-budget-line-label">64 MB warn</span>
            </span>
          </div>
          <div class="memory-budget-legend mono">
            warn at {{ formatBytes(signals.memoryWarnBytes) }} · error at
            {{ formatBytes(signals.memoryErrorBytes) }}
          </div>
        </header>

        <article v-for="entry in memoryRollup" :key="entry.nodeId" class="memory-node-card">
          <header class="memory-node-head">
            <span class="memory-node-name">{{ entry.nodeLabel }}</span>
            <span class="memory-node-bytes mono">{{ formatBytes(entry.bytes) }}</span>
          </header>
          <ul class="memory-decl-list">
            <li v-for="d in entry.declarations" :key="d.name" class="memory-decl-row">
              <span class="u-pill memory-decl-kind" :class="`kind-pill-${d.kind}`">
                {{ d.kind }}
              </span>
              <span class="memory-decl-name mono" :title="d.name">{{ d.name }}</span>
              <span class="memory-decl-bytes mono">{{ formatBytes(d.bytes) }}</span>
            </li>
          </ul>
        </article>
      </section>
    </div>
  </div>
</template>

<style scoped>
.signals-view {
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

.sub-tab-nav {
  display: flex;
  flex-wrap: wrap;
  background: var(--u-bg-elev-1);
  border-bottom: 1px solid var(--u-border);
  padding: 0 16px;
}

.sub-tab {
  padding: 10px 16px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--u-text-muted);
  font-family: var(--u-sans);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  cursor: pointer;
}

.sub-tab:hover {
  color: var(--u-text);
}

.sub-tab.active {
  color: var(--u-text);
  border-bottom-color: var(--u-text);
  font-weight: 600;
}

.view-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 24px;
}

.audio-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.audio-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
}

.port-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.port-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--u-text);
  font-size: 12px;
  cursor: pointer;
}

.port-check-label {
  color: var(--u-text-muted);
}

.audio-header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.audio-grid {
  display: grid;
  /* 280px min keeps all 3 ports on one row at typical devtool iframe widths
     (~900px+). Wraps to 2 rows only past 4 ports / at very narrow viewports.
     `min(100%, 280px)` clamps the floor so columns can shrink below 280px
     when the container is narrower — otherwise auto-fit forces a 280px
     column that overflows view-body horizontally. */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
  gap: 14px;
  /* Don't stretch siblings to match the tallest. Each port-section keeps its
     own natural height, so capturing one port only grows that one — the
     others stay compact instead of inheriting an empty bottom area. */
  align-items: start;
}

.port-section {
  container-type: inline-size;
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 12px;
  /* Stop the article from claiming more width than its grid cell allows.
     Without this, the captured <audio> element's intrinsic min-width (~300px
     for its controls) pushed the article wide enough that `auto-fit` in
     `.audio-grid` dropped from 3 columns to 2 the moment any port captured. */
  min-width: 0;
}

.port-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--u-border);
  margin-bottom: 10px;
}

.audio-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--u-text-dim);
  font-size: 12px;
  background: var(--u-bg-elev-1);
  border: 1px dashed var(--u-border);
  border-radius: var(--u-radius);
}

.port-head-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--u-text);
}

.port-head-meta {
  font-size: 10.5px;
  color: var(--u-text-dim);
}

.port-head-cta {
  margin-left: auto;
}

.port-captured {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
}

.port-captured-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.port-captured-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.port-captured-tag {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--u-success);
  letter-spacing: 0.04em;
}

.port-captured-time {
  font-size: 10.5px;
  color: var(--u-text-muted);
  letter-spacing: 0.02em;
}

.captured-audio {
  width: 100%;
  min-width: 0;
  height: 32px;
}

.captured-audio::-webkit-media-controls-panel {
  background: var(--u-bg-elev-2);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  background: var(--u-bg-elev-2);
  color: var(--u-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition:
    background 80ms,
    color 80ms,
    border-color 80ms;
}

.icon-btn:hover {
  background: var(--u-bg-elev-3);
  border-color: var(--u-border-strong);
  color: var(--u-text);
}

/* Stacks multiple PortChannelView instances vertically (= one per channel).
   The waveform / spectrogram side-by-side responsive layout lives inside
   PortChannelView itself via its own container query. */
.port-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Used by the latency chart header (PortChannelView has its own scoped copy). */
.canvas-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.canvas-title {
  font-size: 11px;
  color: var(--u-text-muted);
}

.canvas-meta {
  font-size: 10.5px;
  color: var(--u-text-dim);
}

.latency-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.latency-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 10px;
}

.latency-stat-card {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 12px;
}

.latency-stat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.latency-stat-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.latency-stat-name {
  font-size: 11.5px;
  color: var(--u-text);
  font-weight: 600;
}

.latency-stat-rows {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
}

.latency-stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}

.latency-stat-key {
  color: var(--u-text-dim);
}

.latency-stat-val {
  color: var(--u-text);
}

.latency-chart-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.latency-canvas {
  width: 100%;
  height: 260px;
  background-color: var(--u-bg);
  background-image:
    linear-gradient(rgba(255, 250, 240, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 250, 240, 0.04) 1px, transparent 1px);
  background-size: 40px 40px;
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
}

.memory-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.memory-summary {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.memory-total-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.memory-total-label {
  color: var(--u-text-muted);
  font-size: 12px;
}

.memory-total-bytes {
  color: var(--u-text);
  font-size: 14px;
  font-weight: 600;
}

.memory-budget-track {
  position: relative;
  height: 8px;
  background: var(--u-bg-elev-3);
  border-radius: 4px;
  overflow: visible;
}

.memory-budget-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--u-success), var(--u-accent));
  border-radius: 4px;
}

.memory-budget-line.warn {
  position: absolute;
  top: -4px;
  bottom: -4px;
  right: 0;
  width: 2px;
  background: var(--u-warn);
}

.memory-budget-line-label {
  position: absolute;
  top: -16px;
  right: 0;
  font-size: 9px;
  color: var(--u-warn);
  transform: translateX(50%);
}

.memory-budget-legend {
  color: var(--u-text-dim);
  font-size: 10.5px;
}

.memory-node-card {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 14px 12px;
}

.memory-node-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--u-border);
  margin-bottom: 8px;
}

.memory-node-name {
  font-family: var(--u-headline);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--u-text);
}

.memory-node-bytes {
  font-size: 12px;
  color: var(--u-text);
}

.memory-decl-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.memory-decl-row {
  display: grid;
  grid-template-columns: 70px 1fr 80px;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.memory-decl-kind {
  font-size: 9.5px;
  padding: 0 5px;
}

.memory-decl-name {
  color: var(--u-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-decl-bytes {
  text-align: right;
  color: var(--u-text-muted);
}

.kind-pill-state,
.kind-pill-buffer,
.kind-pill-lookup,
.kind-pill-midi,
.kind-pill-message,
.kind-pill-param,
.kind-pill-event {
  background: var(--u-bg-elev-4);
  color: var(--u-text);
}
</style>
