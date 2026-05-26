<script setup lang="ts">
import { computed, ref } from "vue";

import { useMockGraph, type BuildIssue } from "../composables/useMockGraph";

type Tab = "ast" | "errors" | "state" | "snapshot";

const TAB_LABELS: Record<Tab, string> = {
  ast: "AST",
  errors: "Build errors",
  state: "State",
  snapshot: "Snapshot",
};
const TAB_ORDER: Tab[] = ["ast", "errors", "state", "snapshot"];

const COL_W = 200;
const COL_X0 = 50;
const ROW_Y0 = 70;
const NODE_W = 140;
const NODE_H = 60;

const graph = useMockGraph();
const activeTab = ref<Tab>("ast");

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
const selectedAst = computed(() => (selectedId.value ? graph.astDecls(selectedId.value) : []));
const selectedIssues = computed(() =>
  selectedId.value ? graph.buildIssuesByNode(selectedId.value) : [],
);
const selectedState = computed(() => (selectedId.value ? graph.stateSlots(selectedId.value) : []));
const selectedSnapshot = computed(() =>
  selectedId.value ? graph.snapshotSlots(selectedId.value) : [],
);

const totalAstBytes = computed(() => selectedAst.value.reduce((acc, d) => acc + d.bytes, 0));
const totalSnapshotBytes = computed(() =>
  selectedSnapshot.value.reduce((acc, d) => acc + d.bytes, 0),
);

const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
};

// Trim the `src/processors/` prefix that all mock issues share, so the row
// stays scannable. `:line` is preserved (column dropped — surfaced inside the
// modal where it has room).
const shortSrc = (src: string): string => {
  const tail = src.split("/").pop() ?? src;
  const m = tail.match(/^(.+\.ts):(\d+)(?::\d+)?$/);
  return m ? `${m[1]}:${m[2]}` : tail;
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

const onModalBackdropClick = (event: MouseEvent): void => {
  if (event.target === issueModalRef.value) closeIssue();
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
          viewBox="0 0 1140 220"
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
        <div class="detail-head">
          <div class="detail-title">{{ selectedNode?.label ?? "—" }}</div>
          <div class="detail-sub">
            <span class="u-pill">{{ selectedNode?.audioNodeType ?? "" }}</span>
            <span v-if="selectedNode?.kind === 'unworklet'" class="u-pill u-pill--accent">
              unworklet
            </span>
          </div>
        </div>

        <nav class="tab-nav">
          <button
            v-for="t in TAB_ORDER"
            :key="t"
            class="tab"
            :class="{ active: activeTab === t }"
            @click="activeTab = t"
          >
            <span>{{ TAB_LABELS[t] }}</span>
            <span v-if="t === 'errors' && selectedIssues.length > 0" class="tab-count">
              {{ selectedIssues.length }}
            </span>
          </button>
        </nav>

        <div class="tab-body">
          <div v-if="activeTab === 'ast'" class="ast-table">
            <div v-if="selectedAst.length === 0" class="empty">No declarations for this node.</div>
            <template v-else>
              <div class="row row-head">
                <div class="cell c-kind">kind</div>
                <div class="cell c-type">type</div>
                <div class="cell c-name">name</div>
                <div class="cell c-bytes">bytes</div>
              </div>
              <div v-for="d in selectedAst" :key="d.name" class="row">
                <div class="cell c-kind">
                  <span class="u-pill" :class="`kind-pill-${d.kind}`">{{ d.kind }}</span>
                </div>
                <div class="cell c-type mono">{{ d.type }}</div>
                <div class="cell c-name mono">
                  {{ d.name }}
                  <span v-if="d.note" class="note">({{ d.note }})</span>
                </div>
                <div class="cell c-bytes mono">{{ formatBytes(d.bytes) }}</div>
              </div>
              <div class="row row-foot">
                <div class="cell c-kind"></div>
                <div class="cell c-type"></div>
                <div class="cell c-name">total</div>
                <div class="cell c-bytes mono">{{ formatBytes(totalAstBytes) }}</div>
              </div>
            </template>
          </div>

          <div v-else-if="activeTab === 'errors'" class="errors-list">
            <div v-if="selectedIssues.length === 0" class="empty">
              No build issues for this node.
            </div>
            <button
              v-for="iss in selectedIssues"
              :key="iss.code"
              type="button"
              class="issue-row"
              :class="`level-${iss.level}`"
              @click="openIssue(iss)"
            >
              <span class="issue-row-code mono">{{ iss.code }}</span>
              <span class="issue-row-message">{{ iss.message }}</span>
              <span class="issue-row-src mono">{{ shortSrc(iss.src) }}</span>
              <span class="issue-row-chev" aria-hidden="true">›</span>
            </button>
          </div>

          <div v-else-if="activeTab === 'state'" class="state-table">
            <div v-if="selectedState.length === 0" class="empty">No state slots for this node.</div>
            <template v-else>
              <div class="row row-head">
                <div class="cell c-name">name</div>
                <div class="cell c-type">type</div>
                <div class="cell c-preview">live value</div>
              </div>
              <div v-for="s in selectedState" :key="s.name" class="row">
                <div class="cell c-name mono">
                  {{ s.name }}
                  <span class="u-pill" :class="`kind-pill-${s.kind}`">{{ s.kind }}</span>
                </div>
                <div class="cell c-type mono">{{ s.type }}</div>
                <div class="cell c-preview mono">{{ s.preview }}</div>
              </div>
            </template>
            <p class="hint">
              Real-time animation lives in the <strong>Live state</strong> view; this tab shows the
              most recent published value.
            </p>
          </div>

          <div v-else class="snapshot-table">
            <header class="snapshot-head">
              <button class="u-btn u-btn--primary" disabled>Capture</button>
              <span class="snapshot-meta mono">
                {{ selectedSnapshot.length }} slots ·
                {{ formatBytes(totalSnapshotBytes) }}
              </span>
            </header>
            <div v-if="selectedSnapshot.length === 0" class="empty">
              No snapshot slots for this node.
            </div>
            <template v-else>
              <div class="row row-head">
                <div class="cell c-name">name</div>
                <div class="cell c-bytes">bytes</div>
                <div class="cell c-preview">preview</div>
              </div>
              <div v-for="s in selectedSnapshot" :key="s.name" class="row">
                <div class="cell c-name mono">{{ s.name }}</div>
                <div class="cell c-bytes mono">{{ formatBytes(s.bytes) }}</div>
                <div class="cell c-preview mono">{{ s.preview }}</div>
              </div>
            </template>
            <p class="hint">
              Capture surfaces <code>node.snapshot()</code> in Phase 11 — restoration replays the
              slot binary on a fresh node instance.
            </p>
          </div>
        </div>
      </aside>
    </div>

    <dialog ref="issueModalRef" class="issue-modal" @click="onModalBackdropClick">
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
  font-size: 14px;
  font-weight: 600;
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
  background: radial-gradient(circle at 30% 30%, rgba(130, 191, 255, 0.04), transparent 60%);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
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
  stroke: var(--u-unworklet);
}

.node.selected .node-box {
  stroke-width: 2.2;
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
  color: var(--u-unworklet);
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
}

.detail-head {
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--u-border);
}

.detail-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--u-text);
  margin-bottom: 6px;
}

.detail-sub {
  display: flex;
  gap: 6px;
}

.tab-nav {
  display: flex;
  border-bottom: 1px solid var(--u-border);
  background: var(--u-bg-elev-1);
}

.tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 4px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--u-text-dim);
  font-size: 11.5px;
  cursor: pointer;
}

.tab:hover {
  color: var(--u-text);
}

.tab.active {
  color: var(--u-accent);
  border-bottom-color: var(--u-accent);
  font-weight: 600;
}

.tab-count {
  background: var(--u-danger);
  color: var(--u-bg);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
}

.tab-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}

.row {
  display: grid;
  grid-template-columns: 70px 56px 1fr 80px;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--u-border);
  font-size: 12px;
}

.row-head {
  color: var(--u-text-dim);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--u-border);
  font-weight: 600;
}

.row-foot {
  color: var(--u-text-muted);
  font-weight: 600;
  border-bottom: 0;
}

.state-table .row {
  grid-template-columns: 1.5fr 50px 1fr;
}

.snapshot-table .row {
  grid-template-columns: 1.5fr 70px 1.5fr;
}

.cell {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-bytes {
  justify-content: flex-end;
}

.c-name .u-pill {
  font-size: 9px;
  padding: 0 5px;
}

.note {
  color: var(--u-text-dim);
  margin-left: 4px;
  font-size: 11px;
}

.kind-pill-state {
  background: rgba(130, 191, 255, 0.16);
  color: var(--u-accent);
}

.kind-pill-buffer {
  background: rgba(98, 209, 138, 0.16);
  color: var(--u-success);
}

.kind-pill-lookup {
  background: rgba(255, 139, 61, 0.16);
  color: var(--u-orange);
}

.kind-pill-midi {
  background: rgba(255, 99, 166, 0.16);
  color: var(--u-midi);
}

.kind-pill-message {
  background: rgba(200, 156, 255, 0.16);
  color: var(--u-unworklet);
}

.empty {
  padding: 20px 12px;
  text-align: center;
  color: var(--u-text-dim);
  font-size: 12px;
}

.errors-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.issue-row {
  display: grid;
  grid-template-columns: 64px 1fr auto 14px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  text-align: left;
  background: var(--u-bg-elev-2);
  border: 1px solid var(--u-border);
  border-left-width: 3px;
  border-radius: var(--u-radius);
  color: var(--u-text);
  font-size: 12px;
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
  font-size: 10.5px;
  font-weight: 700;
  color: var(--u-text);
  background: var(--u-bg-elev-3);
  padding: 2px 6px;
  border-radius: 3px;
  text-align: center;
}

.issue-row.level-warning .issue-row-code {
  color: var(--u-warn);
}

.issue-row.level-error .issue-row-code {
  color: var(--u-danger);
}

.issue-row-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--u-text);
}

.issue-row-src {
  color: var(--u-text-dim);
  font-size: 10.5px;
}

.issue-row-chev {
  color: var(--u-text-dim);
  font-size: 18px;
  line-height: 1;
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

.snapshot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.snapshot-head .u-btn[disabled] {
  opacity: 0.65;
  cursor: not-allowed;
}

.snapshot-meta {
  color: var(--u-text-dim);
  font-size: 11px;
}

.hint {
  margin-top: 14px;
  padding: 10px 12px;
  background: var(--u-bg-elev-2);
  border-radius: var(--u-radius-sm);
  color: var(--u-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.hint code {
  background: var(--u-bg-elev-3);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
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

.snippet-line.highlight {
  background: rgba(255, 99, 99, 0.12);
  box-shadow: inset 3px 0 0 var(--u-danger);
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

.snippet-line.highlight .snippet-text {
  color: #ffe6e6;
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
</style>
