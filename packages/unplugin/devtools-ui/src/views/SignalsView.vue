<script setup lang="ts">
import { computed, ref } from "vue";

import PortChannelView from "../components/PortChannelView.vue";
import { useLiveSignals } from "../composables/useLiveSignals";

type SubTab = "audio" | "latency" | "memory";

const TAB_LABELS: Record<SubTab, string> = {
  audio: "Audio",
  latency: "Latency",
  memory: "Memory",
};
const TAB_ORDER: SubTab[] = ["audio", "latency", "memory"];

const signals = useLiveSignals();
const activeTab = ref<SubTab>("audio");

// 64 MB matches the compiler's memory-budget warning threshold (analyze.ts).
const MEMORY_WARN_BYTES = 64 * 1024 * 1024;

const ports = computed(() =>
  signals.nodes.value.flatMap((n) =>
    n.ports.map((portName) => ({ nodeId: n.id, displayName: n.displayName, portName })),
  ),
);

const totalMemoryBytes = computed(() =>
  signals.nodes.value.reduce((sum, n) => sum + n.memoryBytes, 0),
);
const memoryWarnRatio = computed(() => totalMemoryBytes.value / MEMORY_WARN_BYTES);

const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const portLabel = (p: { displayName: string; portName: string }): string =>
  `${p.displayName}.${p.portName}`;

const fmtLatency = (ms: number): string => (ms > 0 ? `${ms.toFixed(2)} ms` : "—");
</script>

<template>
  <div class="signals-view">
    <header class="view-header">
      <div class="view-title">Signals &amp; performance</div>
      <div class="view-meta">
        <span class="u-pill">{{ ports.length }} output ports</span>
        <span class="u-pill">{{ signals.context.value.sampleRate || "—" }} Hz</span>
        <span class="u-pill">memory {{ formatBytes(totalMemoryBytes) }}</span>
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
      <!-- ─── Audio ─── -->
      <section v-if="activeTab === 'audio'" class="audio-tab">
        <div v-if="ports.length === 0" class="empty-hint">
          No live output ports. Start the app's audio (resume the AudioContext) to scope each
          unworklet node's output here.
        </div>
        <div v-else class="audio-grid">
          <article v-for="p in ports" :key="portLabel(p)" class="port-section">
            <header class="port-head">
              <span class="port-head-name mono">{{ portLabel(p) }}</span>
            </header>
            <PortChannelView :node-id="p.nodeId" :port-name="p.portName" />
          </article>
        </div>
      </section>

      <!-- ─── Latency ─── -->
      <section v-else-if="activeTab === 'latency'" class="latency-tab">
        <div class="latency-cards">
          <article class="latency-card">
            <header class="latency-card-head">base latency</header>
            <div class="latency-card-val mono">
              {{ fmtLatency(signals.context.value.baseLatencyMs) }}
            </div>
            <p class="latency-card-note">
              AudioContext processing latency — the render-quantum buffering between the worklet and
              the output device.
            </p>
          </article>
          <article class="latency-card">
            <header class="latency-card-head">output latency</header>
            <div class="latency-card-val mono">
              {{ fmtLatency(signals.context.value.outputLatencyMs) }}
            </div>
            <p class="latency-card-note">
              End-to-end latency the AudioContext reports to the hardware output.
            </p>
          </article>
        </div>
        <div class="latency-disclaimer">
          <span class="disclaimer-tag">Not measured</span>
          <p>
            Per-node DSP processing time is not observable from the main thread — the audio thread
            does not report per-quantum cost. The figures above are the AudioContext's own reported
            latencies, which are real. A per-node cost profile would require instrumenting the
            worklet itself.
          </p>
        </div>
      </section>

      <!-- ─── Memory ─── -->
      <section v-else class="memory-tab">
        <header class="memory-summary">
          <div class="memory-total-row">
            <span class="memory-total-label">Total declared memory</span>
            <span class="memory-total-bytes mono">{{ formatBytes(totalMemoryBytes) }}</span>
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
            measured from each node's live linear-memory slots · warn at
            {{ formatBytes(MEMORY_WARN_BYTES) }}
          </div>
        </header>

        <div v-if="signals.nodes.value.length === 0" class="empty-hint">
          No unworklet nodes yet. Create a node to see its declared memory layout.
        </div>

        <article v-for="node in signals.nodes.value" :key="node.id" class="memory-node-card">
          <header class="memory-node-head">
            <span class="memory-node-name">{{ node.displayName }}</span>
            <span class="memory-node-bytes mono">{{ formatBytes(node.memoryBytes) }}</span>
          </header>
          <ul v-if="node.memory.length > 0" class="memory-decl-list">
            <li v-for="d in node.memory" :key="d.name" class="memory-decl-row">
              <span class="u-pill memory-decl-kind">{{ d.kind }}</span>
              <span class="memory-decl-name mono" :title="d.name">{{ d.name }}</span>
              <span class="memory-decl-bytes mono">{{ formatBytes(d.bytes) }}</span>
            </li>
          </ul>
          <p v-else class="memory-decl-empty mono">no dumpable slots</p>
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
  overflow: auto;
  padding: 14px 18px 24px;
}

.empty-hint {
  padding: 24px 16px;
  text-align: center;
  color: var(--u-text-dim);
  font-size: 12px;
  background: var(--u-bg-elev-1);
  border: 1px dashed var(--u-border);
  border-radius: var(--u-radius);
}

/* ── Audio ── */

.audio-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 14px;
  align-items: start;
}

.port-section {
  container-type: inline-size;
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 12px;
  min-width: 0;
}

.port-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--u-border);
  margin-bottom: 10px;
}

.port-head-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--u-text);
}

/* ── Latency ── */

.latency-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.latency-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 12px;
}

.latency-card {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 12px 14px;
}

.latency-card-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--u-text-dim);
  margin-bottom: 6px;
}

.latency-card-val {
  font-size: 22px;
  font-weight: 600;
  color: var(--u-text);
}

.latency-card-note {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--u-text-muted);
}

.latency-disclaimer {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  background: var(--u-bg-elev-1);
  border: 1px dashed var(--u-border);
  border-radius: var(--u-radius);
  padding: 12px 14px;
}

.disclaimer-tag {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--u-warn);
  border: 1px solid var(--u-warn);
  border-radius: var(--u-radius-sm);
  padding: 2px 6px;
}

.latency-disclaimer p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--u-text-muted);
}

/* ── Memory ── */

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
  background: var(--u-bg-elev-4);
  color: var(--u-text);
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

.memory-decl-empty {
  margin: 0;
  font-size: 11px;
  color: var(--u-text-dim);
}
</style>
