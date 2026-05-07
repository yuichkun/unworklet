<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { VueFlow, useVueFlow, type Edge, type Node as FlowNode } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import { Controls } from "@vue-flow/controls";

import { registry, listByCategory } from "../registry";
import type { Patch, PatchNode, Cord } from "../types";

// Node renderers
import AudioNodeView from "./nodes/AudioNodeView.vue";
import SliderView from "./nodes/SliderView.vue";
import VSliderView from "./nodes/VSliderView.vue";
import DialView from "./nodes/DialView.vue";
import NumberBoxView from "./nodes/NumberBoxView.vue";
import ButtonView from "./nodes/ButtonView.vue";
import ToggleView from "./nodes/ToggleView.vue";
import KsliderView from "./nodes/KsliderView.vue";
import MultisliderView from "./nodes/MultisliderView.vue";
import UMenuView from "./nodes/UMenuView.vue";
import CommentView from "./nodes/CommentView.vue";
import GenView from "./nodes/GenView.vue";
import PatcherView from "./nodes/PatcherView.vue";
import LiveDialView from "./nodes/LiveDialView.vue";
import LiveSliderView from "./nodes/LiveSliderView.vue";
import ScopeView from "./nodes/ScopeView.vue";
import MeterView from "./nodes/MeterView.vue";
import SpectroscopeView from "./nodes/SpectroscopeView.vue";
import NumberView from "./nodes/NumberView.vue";
import FunctionView from "./nodes/FunctionView.vue";

const props = defineProps<{
  patch: Patch;
  selected: string | null;
}>();

const emit = defineEmits<{
  (e: "select", id: string | null): void;
  (e: "change"): void;
  (e: "param", payload: { nodeId: string; value: number; outletIndex?: number; attrName?: string }): void;
  (e: "descend", payload: { nodeId: string; label: string }): void;
}>();

// Map our component string → Vue component.
const nodeTypes = {
  AudioNodeView,
  SliderView,
  VSliderView,
  DialView,
  NumberBoxView,
  ButtonView,
  ToggleView,
  KsliderView,
  MultisliderView,
  UMenuView,
  CommentView,
  GenView,
  PatcherView,
  LiveDialView,
  LiveSliderView,
  ScopeView,
  MeterView,
  SpectroscopeView,
  NumberView,
  FunctionView,
};

// Convert our Patch into VueFlow's nodes/edges.
const flowNodes = computed<FlowNode[]>(() => {
  return props.patch.nodes.map((n) => {
    const def = registry[n.type];
    return {
      id: n.id,
      type: def?.component ?? "AudioNodeView",
      position: { x: n.pos.x, y: n.pos.y },
      data: {
        node: n,
        def,
        onParam: (value: number, outletIndex?: number, attrName?: string) =>
          emit("param", { nodeId: n.id, value, outletIndex, attrName }),
        onAttrChange: () => emit("change"),
        onDescend: (label: string) => emit("descend", { nodeId: n.id, label }),
      },
    };
  });
});

const flowEdges = computed<Edge[]>(() => {
  return props.patch.cords.map((c, i) => {
    const srcDef = registry[props.patch.nodes.find((n) => n.id === c.src.node)?.type ?? ""];
    const outletKind = srcDef?.outlets[c.src.outlet]?.kind ?? "audio";
    return {
      id: `e${i}`,
      source: c.src.node,
      target: c.dst.node,
      sourceHandle: `out-${c.src.outlet}`,
      targetHandle: `in-${c.dst.inlet}`,
      class: outletKind === "audio" ? "audio-cord" : "control-cord",
    };
  });
});

const { onConnect, onNodeDragStop, onNodesChange, onEdgesChange, addNodes, removeNodes } = useVueFlow();

onConnect((conn) => {
  if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return;
  const outlet = parseInt(conn.sourceHandle.replace("out-", ""), 10);
  const inlet = parseInt(conn.targetHandle.replace("in-", ""), 10);
  const newCord: Cord = {
    src: { node: conn.source, outlet },
    dst: { node: conn.target, inlet },
  };
  // Replace any existing cord on the same destination inlet (Max behavior:
  // a single inlet receives the LATEST cord; we permit additive audio sums
  // by keeping all audio cords on the same inlet — see compile.ts).
  props.patch.cords.push(newCord);
  emit("change");
});

onNodeDragStop((evt) => {
  for (const flowNode of evt.nodes) {
    const n = props.patch.nodes.find((nn) => nn.id === flowNode.id);
    if (!n) continue;
    n.pos = { x: flowNode.position.x, y: flowNode.position.y };
  }
});

// Right-click → palette.
const showPalette = ref(false);
const palettePos = ref({ x: 0, y: 0 });
const paletteCanvasPos = ref({ x: 0, y: 0 });
const paletteSearch = ref("");

const { project } = useVueFlow();

function onCanvasContextMenu(e: MouseEvent) {
  e.preventDefault();
  showPalette.value = true;
  palettePos.value = { x: e.clientX, y: e.clientY };
  // Convert screen → canvas coordinates (so the new node spawns where we clicked).
  paletteCanvasPos.value = project({ x: e.clientX, y: e.clientY - 44 /* toolbar */ });
  paletteSearch.value = "";
}

function closePalette() {
  showPalette.value = false;
}

const grouped = computed(() => listByCategory());
const filteredGroups = computed(() => {
  const q = paletteSearch.value.toLowerCase();
  if (!q) return grouped.value;
  const out: Record<string, any[]> = {};
  for (const [cat, defs] of Object.entries(grouped.value)) {
    const matches = defs.filter((d) => d.type.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q));
    if (matches.length) out[cat] = matches;
  }
  return out;
});

function addNode(type: string) {
  const def = registry[type];
  if (!def) return;
  const id = `${type.replace(/[^a-z0-9]/gi, "_")}_${Date.now().toString(36).slice(-5)}`;
  const newNode: PatchNode = {
    id,
    type,
    pos: { x: paletteCanvasPos.value.x, y: paletteCanvasPos.value.y },
    args: def.defaultArgs ? [...def.defaultArgs] : undefined,
    attrs: def.defaultAttrs
      ? { ...def.defaultAttrs }
      : Object.fromEntries((def.attrs ?? []).map((a) => [a.name, a.default])),
  };
  props.patch.nodes.push(newNode);
  closePalette();
  emit("change");
}

function deleteSelected() {
  if (!props.selected) return;
  const id = props.selected;
  props.patch.nodes = props.patch.nodes.filter((n) => n.id !== id);
  props.patch.cords = props.patch.cords.filter((c) => c.src.node !== id && c.dst.node !== id);
  emit("select", null);
  emit("change");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Delete" || e.key === "Backspace") {
    if (props.selected && document.activeElement?.tagName !== "INPUT") {
      e.preventDefault();
      deleteSelected();
    }
  }
}

function onNodeClick(_e: any, node: FlowNode) {
  emit("select", node.id);
}

watch(
  () => props.patch.cords.length,
  () => emit("change"),
);
</script>

<template>
  <div class="canvas-host" @keydown="onKeydown" tabindex="0">
    <VueFlow
      :nodes="flowNodes"
      :edges="flowEdges"
      :node-types="nodeTypes"
      :default-edge-options="{ type: 'default' }"
      @node-click="onNodeClick"
      @edges-change="onEdgesChange"
      @nodes-change="onNodesChange"
      @pane-context-menu="onCanvasContextMenu"
      @pane-click="closePalette"
    >
      <Background pattern-color="#2c2d31" :gap="20" />
      <MiniMap pannable zoomable />
      <Controls />
    </VueFlow>

    <div
      v-if="showPalette"
      class="palette"
      :style="{ left: palettePos.x + 'px', top: palettePos.y + 'px' }"
    >
      <input
        v-model="paletteSearch"
        placeholder="search… (e.g. cycle, lores, dial)"
        autofocus
        @click.stop
        @keydown.escape="closePalette"
      />
      <div class="palette-body">
        <div v-for="(defs, cat) in filteredGroups" :key="cat">
          <div class="palette-cat">{{ cat }}</div>
          <button
            v-for="d in defs"
            :key="d.type"
            class="palette-item"
            @click.stop="addNode(d.type)"
            :title="d.description"
          >
            {{ d.type }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.canvas-host {
  flex: 1;
  position: relative;
  min-width: 0;
  outline: none;
}
.palette {
  position: fixed;
  z-index: 100;
  background: #2c2d31;
  border: 1px solid #494a52;
  border-radius: 4px;
  width: 320px;
  max-height: 70vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
}
.palette input {
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-bottom: 1px solid #494a52;
  background: #21222a;
  color: #d8d9dc;
  font-family: "JetBrains Mono", monospace;
}
.palette-body {
  overflow-y: auto;
  padding: 4px 0;
}
.palette-cat {
  padding: 6px 10px 2px;
  font-size: 10px;
  text-transform: uppercase;
  color: #888;
  letter-spacing: 0.06em;
}
.palette-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 4px 14px;
  border-radius: 0;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
}
.palette-item:hover {
  background: #00d4aa;
  color: #111;
}
</style>
