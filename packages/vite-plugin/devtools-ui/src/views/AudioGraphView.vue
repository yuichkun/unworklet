<script setup lang="ts">
import { computed, ref } from "vue";

import { type BuildIssue, useMockGraph } from "../composables/useMockGraph";
import { useMockSignals } from "../composables/useMockSignals";

const COL_W = 200;
const COL_X0 = 50;
const ROW_Y0 = 70;
const NODE_W = 140;
const NODE_H = 60;

const graph = useMockGraph();
const signals = useMockSignals();

const nodeLayout = computed(() =>
  graph.nodes.map((n) => ({
    ...n,
    x: COL_X0 + n.col * COL_W,
    y: ROW_Y0 + n.row * (NODE_H + 30),
  })),
);

const nodeById = computed(() => Object.fromEntries(nodeLayout.value.map((n) => [n.id, n])));

const edgePaths = computed(() =>
  graph.edges
    .map((e) => {
      const a = nodeById.value[e.from];
      const b = nodeById.value[e.to];
      if (!a || !b) return null;
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const dx = (x2 - x1) * 0.5;
      return {
        id: e.id,
        channel: e.channel,
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null),
);

const selectedId = computed(() => graph.selectedId.value);
const selectedNode = computed(() => graph.selectedNode.value);
const selectedIssues = computed(() =>
  selectedId.value ? graph.buildIssuesByNode(selectedId.value) : [],
);
const selectedSnapshot = computed(() =>
  selectedId.value ? graph.snapshotSlots(selectedId.value) : [],
);
const selectedPublish = computed(() =>
  selectedId.value ? graph.publishSlots(selectedId.value) : [],
);
const selectedIO = computed(() => (selectedId.value ? graph.nodeIO(selectedId.value) : null));
const selectedAst = computed(() => (selectedId.value ? graph.astDecls(selectedId.value) : []));

const selectedMemoryBytes = computed(() => selectedAst.value.reduce((acc, d) => acc + d.bytes, 0));

const LATENCY_NODE_SET = new Set<string>(signals.latencyNodeIds as readonly string[]);
const selectedLatency = computed(() => {
  const sel = selectedId.value;
  if (!sel || !LATENCY_NODE_SET.has(sel)) return null;
  return signals.getLatencyStats(sel);
});

const totalSnapshotBytes = computed(() =>
  selectedSnapshot.value.reduce((acc, d) => acc + d.bytes, 0),
);

const publishBreakdown = computed(() => {
  const scalars = selectedPublish.value.filter((s) => s.kind === "state");
  const buffers = selectedPublish.value.filter((s) => s.kind === "buffer");
  return { scalars, buffers };
});

const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
};

const shortSrc = (src: string): string => {
  const tail = src.split("/").pop() ?? src;
  const m = tail.match(/^(.+\.ts):(\d+)(?::\d+)?$/);
  return m ? `${m[1]}:${m[2]}` : tail;
};

const STATUS_LABEL: Record<string, string> = {
  ok: "Healthy",
  warning: "Warnings",
  errors: "Errors",
};

const issueModalRef = ref<HTMLDialogElement | null>(null);
const activeIssue = ref<BuildIssue | null>(null);

const openIssue = (iss: BuildIssue): void => {
  activeIssue.value = iss;
  issueModalRef.value?.showModal();
};

const closeIssue = (): void => {
  issueModalRef.value?.close();
};

const onIssueBackdropClick = (event: MouseEvent): void => {
  if (event.target === issueModalRef.value) closeIssue();
};

const snapshotModalRef = ref<HTMLDialogElement | null>(null);
const openSnapshot = (): void => {
  snapshotModalRef.value?.showModal();
};
const closeSnapshot = (): void => {
  snapshotModalRef.value?.close();
};
const onSnapshotBackdropClick = (event: MouseEvent): void => {
  if (event.target === snapshotModalRef.value) closeSnapshot();
};
</script>

<template>
  <div class="audio-graph-view">
    <header class="view-header">
      <div class="view-title">Audio graph</div>
      <div class="view-meta">
        <span class="u-pill">{{ graph.nodes.length }} nodes</span>
        <span class="u-pill u-pill--danger">{{ graph.errorIssueCount.value }} errors</span>
        <span class="u-pill u-pill--warn">{{ graph.warningIssueCount.value }} warnings</span>
      </div>
    </header>

    <div class="view-body">
      <section class="graph-pane">
        <svg
          class="graph-svg"
          viewBox="0 0 1340 220"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Audio graph diagram"
        >
          <defs>
            <marker
              id="arrow-audio"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--u-accent)" />
            </marker>
            <marker
              id="arrow-midi"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--u-midi)" />
            </marker>
          </defs>

          <path
            v-for="edge in edgePaths"
            :key="edge.id"
            :d="edge.d"
            class="edge"
            :class="`edge-${edge.channel}`"
            fill="none"
            :marker-end="`url(#arrow-${edge.channel})`"
          />

          <g
            v-for="node in nodeLayout"
            :key="node.id"
            class="node"
            :class="[`kind-${node.kind}`, { selected: selectedId === node.id }]"
            @click="graph.selectNode(node.id)"
          >
            <rect
              :x="node.x"
              :y="node.y"
              :width="NODE_W"
              :height="NODE_H"
              rx="8"
              class="node-box"
            />
            <circle
              :cx="node.x + 12"
              :cy="node.y + 12"
              r="3.5"
              class="status-dot"
              :class="`status-${node.status}`"
            />
            <foreignObject
              :x="node.x + 8"
              :y="node.y + 16"
              :width="NODE_W - 16"
              :height="NODE_H - 22"
            >
              <div xmlns="http://www.w3.org/1999/xhtml" class="node-text">
                <div class="node-name" :title="node.label">{{ node.label }}</div>
                <div class="node-type" :title="node.audioNodeType">{{ node.audioNodeType }}</div>
              </div>
            </foreignObject>
            <g v-if="node.errorCount > 0" class="node-badge-g">
              <circle :cx="node.x + NODE_W - 12" :cy="node.y + 12" r="8" class="node-badge-bg" />
              <text
                :x="node.x + NODE_W - 12"
                :y="node.y + 15"
                text-anchor="middle"
                class="node-badge-txt"
              >
                {{ node.errorCount }}
              </text>
            </g>
          </g>
        </svg>

        <footer class="graph-legend">
          <span class="legend-item">
            <span class="legend-swatch audio"></span>
            audio edge
          </span>
          <span class="legend-item">
            <span class="legend-swatch midi"></span>
            midi edge
          </span>
          <span class="legend-item">
            <span class="legend-swatch unworklet"></span>
            unworklet node
          </span>
          <span class="legend-item">
            <span class="legend-swatch standard"></span>
            standard AudioNode
          </span>
        </footer>
      </section>

      <aside class="detail-pane">
        <template v-if="selectedNode">
          <header class="detail-head">
            <div class="detail-title">{{ selectedNode.label }}</div>
            <div class="detail-sub">
              <span class="u-pill">{{ selectedNode.audioNodeType }}</span>
              <span v-if="selectedNode.kind === 'unworklet'" class="u-pill u-pill--accent">
                unworklet
              </span>
            </div>
          </header>

          <div class="summary-body">
            <section class="summary-section">
              <header class="summary-section-head">Stats</header>
              <dl class="summary-list">
                <div class="summary-row">
                  <dt>status</dt>
                  <dd>
                    <span class="status-pip" :class="`status-${selectedNode.status}`"></span>
                    {{ STATUS_LABEL[selectedNode.status] }}
                    <span v-if="selectedNode.errorCount > 0" class="row-muted">
                      ({{ selectedNode.errorCount }} issue{{
                        selectedNode.errorCount === 1 ? "" : "s"
                      }})
                    </span>
                  </dd>
                </div>
                <div class="summary-row">
                  <dt>memory</dt>
                  <dd class="mono">{{ formatBytes(selectedMemoryBytes) }}</dd>
                </div>
                <div class="summary-row">
                  <dt>latency P95</dt>
                  <dd class="mono">
                    <template v-if="selectedLatency">
                      {{ selectedLatency.p95.toFixed(2) }} ms
                    </template>
                    <span v-else class="row-muted">—</span>
                  </dd>
                </div>
              </dl>
            </section>

            <section v-if="selectedIO" class="summary-section">
              <header class="summary-section-head">I/O</header>
              <dl class="summary-list">
                <div v-if="selectedIO.audioIn" class="summary-row">
                  <dt>audio in</dt>
                  <dd class="mono">
                    {{ selectedIO.audioIn.name }}
                    <span class="row-muted">({{ selectedIO.audioIn.channels }} ch)</span>
                  </dd>
                </div>
                <div v-if="selectedIO.audioOut" class="summary-row">
                  <dt>audio out</dt>
                  <dd class="mono">
                    {{ selectedIO.audioOut.name }}
                    <span class="row-muted">({{ selectedIO.audioOut.channels }} ch)</span>
                  </dd>
                </div>
                <div v-if="selectedIO.midiIn.length > 0" class="summary-row">
                  <dt>MIDI in</dt>
                  <dd class="mono">{{ selectedIO.midiIn.join(", ") }}</dd>
                </div>
                <div v-if="selectedIO.midiOut.length > 0" class="summary-row">
                  <dt>MIDI out</dt>
                  <dd class="mono">{{ selectedIO.midiOut.join(", ") }}</dd>
                </div>
                <div
                  v-if="
                    !selectedIO.audioIn &&
                    !selectedIO.audioOut &&
                    selectedIO.midiIn.length === 0 &&
                    selectedIO.midiOut.length === 0
                  "
                  class="summary-row"
                >
                  <dt>—</dt>
                  <dd class="row-muted">No declared I/O</dd>
                </div>
              </dl>
            </section>

            <section v-if="selectedPublish.length > 0" class="summary-section">
              <header class="summary-section-head">
                Publish slots
                <span class="head-count">({{ selectedPublish.length }})</span>
              </header>
              <dl class="summary-list">
                <div v-if="publishBreakdown.scalars.length > 0" class="summary-row">
                  <dt>state</dt>
                  <dd class="mono">
                    {{ publishBreakdown.scalars.map((s) => s.name).join(", ") }}
                  </dd>
                </div>
                <div v-if="publishBreakdown.buffers.length > 0" class="summary-row">
                  <dt>buffer</dt>
                  <dd class="mono">
                    {{ publishBreakdown.buffers.map((s) => s.name).join(", ") }}
                  </dd>
                </div>
              </dl>
              <p class="section-link">See <strong>Live state</strong> view for real-time values.</p>
            </section>

            <section class="summary-section">
              <header class="summary-section-head">
                Build issues
                <span class="head-count">({{ selectedIssues.length }})</span>
              </header>
              <div v-if="selectedIssues.length === 0" class="empty">No build issues.</div>
              <ul v-else class="issue-list">
                <li v-for="iss in selectedIssues" :key="iss.code">
                  <button
                    type="button"
                    class="issue-row"
                    :class="`level-${iss.level}`"
                    @click="openIssue(iss)"
                  >
                    <span class="issue-row-code mono">{{ iss.code }}</span>
                    <span class="issue-row-message">{{ iss.message }}</span>
                    <span class="issue-row-chev" aria-hidden="true">›</span>
                  </button>
                </li>
              </ul>
            </section>

            <section class="summary-section">
              <header class="summary-section-head">Snapshot</header>
              <div class="snapshot-row">
                <button
                  class="u-btn u-btn--primary"
                  :disabled="selectedSnapshot.length === 0"
                  :title="
                    selectedSnapshot.length === 0
                      ? 'No persistent slots'
                      : 'Inspect persistent slots (Phase 11 in core)'
                  "
                  @click="openSnapshot"
                >
                  Inspect
                </button>
                <span class="snapshot-meta mono">
                  {{ selectedSnapshot.length }} persistent slot{{
                    selectedSnapshot.length === 1 ? "" : "s"
                  }}
                  <template v-if="selectedSnapshot.length > 0">
                    · {{ formatBytes(totalSnapshotBytes) }}
                  </template>
                </span>
              </div>
            </section>
          </div>
        </template>

        <div v-else class="empty empty-detail">Pick a node from the graph.</div>
      </aside>
    </div>

    <dialog ref="issueModalRef" class="issue-modal" @click="onIssueBackdropClick">
      <div class="issue-modal-card">
        <header class="issue-modal-head">
          <span class="issue-code mono">{{ activeIssue?.code }}</span>
          <span class="issue-level" :class="`level-${activeIssue?.level ?? 'error'}`">
            {{ activeIssue?.level }}
          </span>
          <span class="issue-modal-src mono">{{ activeIssue?.src }}</span>
          <button type="button" class="issue-modal-close" aria-label="Close" @click="closeIssue">
            ×
          </button>
        </header>

        <section v-if="activeIssue" class="issue-modal-body">
          <div class="snippet">
            <div
              v-for="(line, idx) in activeIssue.snippet.lines"
              :key="idx"
              class="snippet-line"
              :class="{
                highlight:
                  activeIssue.snippet.startLine + idx === activeIssue.snippet.highlightLine,
                [`highlight-${activeIssue.level}`]:
                  activeIssue.snippet.startLine + idx === activeIssue.snippet.highlightLine,
              }"
            >
              <span class="snippet-lineno mono">{{ activeIssue.snippet.startLine + idx }}</span>
              <span class="snippet-text mono">{{ line }}</span>
            </div>
          </div>

          <h4 class="issue-section-title">Why</h4>
          <p class="issue-section-body">{{ activeIssue.why }}</p>

          <h4 class="issue-section-title">Fix</h4>
          <p class="issue-section-body">{{ activeIssue.fix }}</p>
        </section>

        <footer class="issue-modal-foot">
          <button type="button" class="u-btn u-btn--primary" @click="closeIssue">Close</button>
        </footer>
      </div>
    </dialog>

    <dialog ref="snapshotModalRef" class="issue-modal" @click="onSnapshotBackdropClick">
      <div class="issue-modal-card">
        <header class="issue-modal-head">
          <span class="issue-code mono">Snapshot</span>
          <span class="issue-modal-src mono">{{ selectedNode?.label ?? "" }}</span>
          <button type="button" class="issue-modal-close" aria-label="Close" @click="closeSnapshot">
            ×
          </button>
        </header>

        <section class="issue-modal-body">
          <p class="snapshot-hint">
            <code>node.snapshot()</code> + <code>inspect(blob)</code> become live in Phase 11. Slot
            list below reflects the current declared shape.
          </p>
          <div v-if="selectedSnapshot.length === 0" class="empty">
            No persistent slots for this node.
          </div>
          <ul v-else class="snapshot-list">
            <li v-for="s in selectedSnapshot" :key="s.name" class="snapshot-slot">
              <span class="snapshot-slot-name mono" :title="s.name">{{ s.name }}</span>
              <span class="snapshot-slot-bytes mono">{{ formatBytes(s.bytes) }}</span>
              <span class="snapshot-slot-preview mono" :title="s.preview">{{ s.preview }}</span>
            </li>
          </ul>
        </section>

        <footer class="issue-modal-foot">
          <button type="button" class="u-btn u-btn--primary" @click="closeSnapshot">Close</button>
        </footer>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.audio-graph-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
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
}

.view-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.graph-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 16px 18px;
  overflow: hidden;
}

.graph-svg {
  flex: 1;
  width: 100%;
  background-color: var(--u-bg-elev-1);
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
  background-size: 40px 40px;
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-lg);
}

.edge {
  stroke-width: 1.7;
  transition: stroke-width 120ms;
}

.edge-audio {
  stroke: var(--u-accent);
}

.edge-midi {
  stroke: var(--u-midi);
  stroke-dasharray: 5 4;
}

.node {
  cursor: pointer;
}

.node-box {
  fill: var(--u-bg-elev-2);
  stroke: var(--u-border-strong);
  stroke-width: 1.2;
  transition:
    stroke 120ms,
    stroke-width 120ms,
    fill 120ms;
}

.node.kind-unworklet .node-box {
  stroke: var(--u-text);
}

.node.selected .node-box {
  stroke: var(--u-text);
  stroke-width: 2.5;
  fill: var(--u-bg-elev-3);
}

.status-dot.status-ok {
  fill: var(--u-success);
}

.status-dot.status-warning {
  fill: var(--u-warn);
}

.status-dot.status-errors {
  fill: var(--u-danger);
}

.node-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 2px;
  pointer-events: none;
  text-align: center;
}

.node-name {
  font-family: var(--u-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--u-text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node.kind-unworklet .node-name {
  color: var(--u-text);
}

.node-type {
  font-family: var(--u-mono);
  font-size: 9px;
  color: var(--u-text-dim);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-badge-bg {
  fill: var(--u-danger);
}

.node-badge-txt {
  font-family: var(--u-sans);
  font-size: 10px;
  font-weight: 700;
  fill: var(--u-bg);
}

.graph-legend {
  display: flex;
  gap: 18px;
  padding: 10px 4px 0;
  font-size: 11px;
  color: var(--u-text-dim);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.legend-swatch {
  width: 14px;
  height: 3px;
  border-radius: 2px;
}

.legend-swatch.audio {
  background: var(--u-accent);
}

.legend-swatch.midi {
  background: var(--u-midi);
}

.legend-swatch.unworklet {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--u-unworklet);
  border-radius: 3px;
  background: transparent;
}

.legend-swatch.standard {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--u-border-strong);
  border-radius: 3px;
  background: transparent;
}

.detail-pane {
  flex: 0 0 380px;
  display: flex;
  flex-direction: column;
  background: var(--u-bg-elev-1);
  border-left: 1px solid var(--u-border);
  min-height: 0;
  overflow-y: auto;
}

.detail-head {
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--u-border);
}

.detail-title {
  font-family: var(--u-headline);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--u-text);
  margin-bottom: 6px;
}

.detail-sub {
  display: flex;
  gap: 6px;
}

.summary-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0 16px;
}

.summary-section {
  padding: 10px 18px;
  border-bottom: 1px solid var(--u-border);
}

.summary-section:last-child {
  border-bottom: 0;
}

.summary-section-head {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--u-text-dim);
  margin-bottom: 8px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.head-count {
  font-size: 10px;
  color: var(--u-text-muted);
  letter-spacing: 0;
  text-transform: none;
}

.summary-list {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  row-gap: 4px;
}

.summary-row {
  display: contents;
}

.summary-row dt {
  font-size: 11px;
  color: var(--u-text-dim);
  text-align: right;
}

.summary-row dd {
  margin: 0;
  font-size: 12px;
  color: var(--u-text);
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-muted {
  color: var(--u-text-dim);
  font-size: 10.5px;
}

.status-pip {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  align-self: center;
}

.status-pip.status-ok {
  background: var(--u-success);
}

.status-pip.status-warning {
  background: var(--u-warn);
}

.status-pip.status-errors {
  background: var(--u-danger);
}

.section-link {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--u-text-dim);
}

.section-link strong {
  color: var(--u-text);
  font-weight: 600;
}

.issue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.issue-row {
  display: grid;
  grid-template-columns: 64px 1fr 14px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  text-align: left;
  background: var(--u-bg-elev-2);
  border: 1px solid var(--u-border);
  border-left-width: 3px;
  border-radius: var(--u-radius-sm);
  color: var(--u-text);
  font-size: 11.5px;
  cursor: pointer;
  transition:
    background 80ms,
    border-color 80ms;
}

.issue-row:hover {
  background: var(--u-bg-elev-3);
  border-color: var(--u-border-strong);
}

.issue-row.level-error {
  border-left-color: var(--u-danger);
}

.issue-row.level-warning {
  border-left-color: var(--u-warn);
}

.issue-row-code {
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  background: var(--u-bg-elev-3);
  padding: 1px 5px;
  border-radius: 3px;
}

.issue-row.level-error .issue-row-code {
  color: var(--u-danger);
}

.issue-row.level-warning .issue-row-code {
  color: var(--u-warn);
}

.issue-row-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-row-chev {
  color: var(--u-text-dim);
  font-size: 16px;
  line-height: 1;
}

.snapshot-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.snapshot-meta {
  font-size: 10.5px;
  color: var(--u-text-dim);
}

.empty {
  padding: 10px 6px;
  text-align: center;
  color: var(--u-text-dim);
  font-size: 11.5px;
}

.empty-detail {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
}

.issue-code {
  background: var(--u-bg-elev-3);
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--u-text);
  font-weight: 600;
  font-size: 11px;
}

.issue-level {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
  color: var(--u-text-dim);
}

.issue-level.level-error {
  color: var(--u-danger);
}

.issue-level.level-warning {
  color: var(--u-warn);
}

.issue-modal {
  border: 0;
  padding: 0;
  background: transparent;
  max-width: 720px;
  width: 90vw;
  color: var(--u-text);
}

.issue-modal::backdrop {
  background: rgba(8, 10, 14, 0.6);
  backdrop-filter: blur(2px);
}

.issue-modal-card {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.issue-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--u-border);
  background: var(--u-bg-elev-2);
}

.issue-modal-src {
  flex: 1;
  color: var(--u-text-dim);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-modal-close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--u-radius-sm);
  background: transparent;
  color: var(--u-text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.issue-modal-close:hover {
  background: var(--u-bg-elev-3);
  color: var(--u-text);
}

.issue-modal-body {
  padding: 16px;
  max-height: 60vh;
  overflow-y: auto;
}

.snippet {
  background: var(--u-bg);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  padding: 8px 0;
  margin-bottom: 18px;
  font-size: 12px;
  line-height: 1.55;
  overflow-x: auto;
}

.snippet-line {
  display: grid;
  grid-template-columns: 44px 1fr;
  padding: 0 12px 0 0;
}

.snippet-line.highlight-error {
  background: rgba(255, 180, 171, 0.08);
  box-shadow: inset 3px 0 0 var(--u-danger);
}

.snippet-line.highlight-warning {
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 3px 0 0 var(--u-text-muted);
}

.snippet-lineno {
  text-align: right;
  padding: 0 10px 0 4px;
  color: var(--u-text-dim);
  user-select: none;
  font-size: 11px;
}

.snippet-text {
  color: var(--u-text);
  white-space: pre;
}

.snippet-line.highlight-error .snippet-text {
  color: var(--u-danger);
}

.snippet-line.highlight-warning .snippet-text {
  color: var(--u-text);
}

.issue-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--u-text-dim);
  margin: 14px 0 6px;
}

.issue-section-body {
  margin: 0 0 10px;
  color: var(--u-text);
  font-size: 12.5px;
  line-height: 1.6;
}

.issue-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--u-border);
  background: var(--u-bg-elev-2);
}

.snapshot-hint {
  margin: 0 0 12px;
  font-size: 11.5px;
  color: var(--u-text-muted);
  line-height: 1.5;
}

.snapshot-hint code {
  background: var(--u-bg-elev-3);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
}

.snapshot-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.snapshot-slot {
  display: grid;
  grid-template-columns: 1.4fr 70px 1.6fr;
  gap: 10px;
  padding: 6px 4px;
  font-size: 11.5px;
  border-bottom: 1px solid var(--u-border);
}

.snapshot-slot:last-child {
  border-bottom: 0;
}

.snapshot-slot-name {
  color: var(--u-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snapshot-slot-bytes {
  text-align: right;
  color: var(--u-text-muted);
}

.snapshot-slot-preview {
  color: var(--u-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
