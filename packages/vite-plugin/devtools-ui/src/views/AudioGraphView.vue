<script setup lang="ts">
import { Background, BackgroundVariant } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { type Edge, MarkerType, type Node, VueFlow } from "@vue-flow/core";
import { computed, markRaw } from "vue";

import UnworkletNode from "../components/UnworkletNode.vue";
import { useLiveGraph } from "../composables/useLiveGraph";
import { useLiveState } from "../composables/useLiveState";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";

const live = useLiveGraph();
const liveState = useLiveState();

const nodeTypes = {
  unworklet: markRaw(UnworkletNode),
  standard: markRaw(UnworkletNode),
};

const flowNodes = computed<Node[]>(() =>
  live.placed.value.map((n) => ({
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    data: n,
    selected: live.selectedId.value === n.id,
    selectable: true,
    draggable: false,
    connectable: false,
  })),
);

const flowEdges = computed<Edge[]>(() =>
  live.edges.value.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: "default",
    animated: false,
    markerEnd: MarkerType.ArrowClosed,
    class: "edge-audio",
  })),
);

const labelOf = (id: string): string =>
  live.graph.value.nodes.find((n) => n.id === id)?.label ?? id;

const connections = computed(() => {
  const sel = live.selectedNode.value;
  if (!sel) return { incoming: [] as string[], outgoing: [] as string[] };
  return {
    incoming: live.edges.value.filter((e) => e.to === sel.id).map((e) => labelOf(e.from)),
    outgoing: live.edges.value.filter((e) => e.from === sel.id).map((e) => labelOf(e.to)),
  };
});

const isEmpty = computed(() => live.graph.value.nodes.length === 0);

// The selected node's live X-ray (params + state slots), correlated by node id
// with the Live-state shared state. Present only for unworklet nodes once audio
// is running; standard AudioNodes have none.
const detail = computed(() => {
  const sel = live.selectedNode.value;
  if (!sel || sel.kind !== "unworklet") return null;
  const ns = liveState.nodes.value.find((n) => n.id === sel.id);
  const params = ns ? ns.scalars.filter((s) => s.kind === "param") : [];
  const state = ns ? ns.scalars.filter((s) => s.kind === "state") : [];
  return {
    inputs: sel.inputs ?? [],
    outputs: sel.outputs ?? [],
    params,
    state,
    buffers: ns ? ns.buffers : [],
    hasLive: ns !== undefined,
  };
});

const fmtScalar = (value: number | boolean | string, type: string): string => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (type === "f32" || type === "f64") return value.toFixed(3);
  return String(value);
};

const onNodeClick = (event: { node: Node }): void => {
  live.selectNode(event.node.id);
};
</script>

<template>
  <div class="audio-graph-view">
    <header class="view-header">
      <div class="view-title">Audio graph</div>
      <div class="view-meta">
        <span class="u-pill">{{ live.graph.value.nodes.length }} nodes</span>
        <span class="u-pill">{{ live.edges.value.length }} edges</span>
        <span class="u-pill u-pill--accent">live</span>
      </div>
    </header>

    <div class="view-body">
      <section class="graph-pane">
        <div class="graph-viewport">
          <div v-if="isEmpty" class="graph-empty">
            <p>No live audio nodes yet.</p>
            <p class="graph-empty-sub">
              Start the app's audio (a user gesture) — each <code>createNode</code> and
              <code>AudioNode.connect</code> appears here automatically.
            </p>
          </div>
          <VueFlow
            v-else
            :nodes="flowNodes"
            :edges="flowEdges"
            :node-types="nodeTypes"
            :nodes-draggable="false"
            :nodes-connectable="false"
            :elements-selectable="true"
            :pan-on-drag="true"
            :zoom-on-scroll="true"
            :prevent-scrolling="true"
            :min-zoom="0.2"
            :max-zoom="6"
            fit-view-on-init
            :default-edge-options="{ type: 'default' }"
            @node-click="onNodeClick"
          >
            <Background
              :variant="BackgroundVariant.Dots"
              :gap="20"
              :size="1"
              pattern-color="rgba(255, 250, 240, 0.12)"
            />
            <Controls :show-interactive="false" position="bottom-right" />
          </VueFlow>
        </div>

        <footer class="graph-legend">
          <span class="legend-item"><span class="legend-swatch audio"></span> audio edge</span>
          <span class="legend-item"
            ><span class="legend-swatch unworklet"></span> unworklet node</span
          >
          <span class="legend-item"
            ><span class="legend-swatch standard"></span> standard AudioNode</span
          >
        </footer>
      </section>

      <aside class="detail-pane">
        <template v-if="live.selectedNode.value">
          <header class="detail-head">
            <div class="detail-title">{{ live.selectedNode.value.label }}</div>
            <div class="detail-sub">
              <span class="u-pill">{{ live.selectedNode.value.audioNodeType }}</span>
              <span
                v-if="live.selectedNode.value.kind === 'unworklet'"
                class="u-pill u-pill--accent"
              >
                unworklet
              </span>
            </div>
          </header>

          <div class="summary-body">
            <section class="summary-section">
              <header class="summary-section-head">Connections</header>
              <dl class="summary-list">
                <div class="summary-row">
                  <dt>in</dt>
                  <dd class="mono">
                    <template v-if="connections.incoming.length">
                      {{ connections.incoming.join(", ") }}
                    </template>
                    <span v-else class="row-muted">—</span>
                  </dd>
                </div>
                <div class="summary-row">
                  <dt>out</dt>
                  <dd class="mono">
                    <template v-if="connections.outgoing.length">
                      {{ connections.outgoing.join(", ") }}
                    </template>
                    <span v-else class="row-muted">—</span>
                  </dd>
                </div>
              </dl>
            </section>

            <template v-if="detail">
              <section class="summary-section">
                <header class="summary-section-head">Ports</header>
                <dl class="summary-list">
                  <div class="summary-row">
                    <dt>in</dt>
                    <dd class="mono">
                      <template v-if="detail.inputs.length">{{
                        detail.inputs.join(", ")
                      }}</template>
                      <span v-else class="row-muted">—</span>
                    </dd>
                  </div>
                  <div class="summary-row">
                    <dt>out</dt>
                    <dd class="mono">
                      <template v-if="detail.outputs.length">{{
                        detail.outputs.join(", ")
                      }}</template>
                      <span v-else class="row-muted">—</span>
                    </dd>
                  </div>
                </dl>
              </section>

              <section v-if="detail.params.length" class="summary-section">
                <header class="summary-section-head">Params</header>
                <dl class="kv-list">
                  <div v-for="p in detail.params" :key="p.name" class="kv-row">
                    <dt class="mono">{{ p.name }}</dt>
                    <dd class="mono">{{ fmtScalar(p.value, p.type) }}</dd>
                  </div>
                </dl>
              </section>

              <section v-if="detail.state.length" class="summary-section">
                <header class="summary-section-head">State</header>
                <dl class="kv-list">
                  <div v-for="s in detail.state" :key="s.name" class="kv-row">
                    <dt class="mono">
                      {{ s.name }}<span class="kv-type">{{ s.type }}</span>
                    </dt>
                    <dd class="mono">{{ fmtScalar(s.value, s.type) }}</dd>
                  </div>
                </dl>
              </section>

              <section v-if="detail.buffers.length" class="summary-section">
                <header class="summary-section-head">Buffers</header>
                <dl class="kv-list">
                  <div v-for="b in detail.buffers" :key="b.name" class="kv-row">
                    <dt class="mono">
                      {{ b.name }}<span class="kv-type">{{ b.type }}</span>
                    </dt>
                    <dd class="mono row-muted">× {{ b.length }}</dd>
                  </div>
                </dl>
                <p class="detail-hint">Open the Live state panel to visualize buffer contents.</p>
              </section>

              <section v-if="!detail.hasLive" class="summary-section">
                <p class="pending-note">
                  Start the app's audio to X-ray this node's live params + state.
                </p>
              </section>
            </template>

            <section v-else class="summary-section">
              <p class="pending-note">
                Standard Web-Audio node — unworklet exposes live params + state only for its own
                processor nodes.
              </p>
            </section>
          </div>
        </template>

        <div v-else class="empty empty-detail">
          {{ isEmpty ? "Waiting for live audio nodes…" : "Pick a node from the graph." }}
        </div>
      </aside>
    </div>
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
  display: flex;
  min-height: 0;
}

@media (max-width: 900px) {
  .view-body {
    flex-direction: column;
  }
}

.graph-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 16px 18px;
  overflow: hidden;
}

.graph-viewport {
  flex: 1;
  width: 100%;
  min-height: 0;
  background-color: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-lg);
  overflow: hidden;
  position: relative;
}

.graph-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  padding: 40px;
  color: var(--u-text-dim);
}

.graph-empty p {
  margin: 0;
  font-size: 13px;
}

.graph-empty-sub {
  max-width: 360px;
  font-size: 11.5px;
  line-height: 1.5;
}

.graph-empty code {
  background: var(--u-bg-elev-3);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10.5px;
}

.graph-viewport :deep(.vue-flow) {
  width: 100%;
  height: 100%;
  background: transparent;
  color: var(--u-text);
}

.graph-viewport :deep(.vue-flow__handle) {
  width: 1px;
  height: 1px;
  min-width: 0;
  min-height: 0;
  border: 0;
  background: transparent;
  opacity: 0;
  pointer-events: none;
}

.graph-viewport :deep(.vue-flow__edge-path) {
  stroke: var(--u-text-muted);
  stroke-width: 1.5;
  fill: none;
}

.graph-viewport :deep(.vue-flow__edge.edge-audio .vue-flow__edge-path) {
  stroke: var(--u-text);
}

.graph-viewport :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: var(--u-text);
  stroke-width: 2;
}

.graph-viewport :deep(.vue-flow__arrowhead path) {
  fill: var(--u-text);
  stroke: var(--u-text);
}

.graph-viewport :deep(.vue-flow__controls) {
  background: var(--u-bg-elev-2);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  box-shadow: none;
  display: flex;
  flex-direction: row;
  padding: 2px;
  gap: 2px;
}

.graph-viewport :deep(.vue-flow__controls-button) {
  background: transparent;
  border: 0;
  border-radius: 0;
  color: var(--u-text-muted);
  width: 28px;
  height: 28px;
  fill: currentColor;
}

.graph-viewport :deep(.vue-flow__controls-button:hover) {
  background: var(--u-bg-elev-3);
  color: var(--u-text);
}

.graph-viewport :deep(.vue-flow__controls-button svg) {
  max-width: 14px;
  max-height: 14px;
}

.graph-viewport :deep(.vue-flow__node) {
  outline: none;
}

.graph-legend {
  display: flex;
  align-items: center;
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
  flex: 0 0 360px;
  display: flex;
  flex-direction: column;
  background: var(--u-bg-elev-1);
  border-left: 1px solid var(--u-border);
  min-height: 0;
  overflow-y: auto;
}

@media (max-width: 900px) {
  .detail-pane {
    flex: 0 0 auto;
    max-height: 320px;
    border-left: 0;
    border-top: 1px solid var(--u-border);
  }
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
  overflow-wrap: anywhere;
}

.detail-sub {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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
}

.summary-list {
  margin: 0;
  display: grid;
  grid-template-columns: 50px 1fr;
  column-gap: 14px;
  row-gap: 6px;
  align-items: baseline;
}

.summary-row {
  display: contents;
}

.summary-row dt {
  font-size: 12px;
  line-height: 1.4;
  color: var(--u-text-muted);
}

.summary-row dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--u-text);
  overflow-wrap: anywhere;
}

.row-muted {
  color: var(--u-text-dim);
  font-size: 11px;
}

.pending-note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--u-text-dim);
}

.kv-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kv-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  column-gap: 12px;
}

.kv-row dt {
  font-size: 12px;
  color: var(--u-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv-type {
  margin-left: 6px;
  font-size: 9.5px;
  color: var(--u-text-dim);
}

.kv-row dd {
  margin: 0;
  font-size: 12px;
  color: var(--u-text);
  text-align: right;
  overflow-wrap: anywhere;
}

.detail-hint {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.5;
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
</style>
