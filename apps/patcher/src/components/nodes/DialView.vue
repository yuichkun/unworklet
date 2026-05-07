<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void }>>();
const min = computed(() => Number(props.data.node.attrs?.min ?? 0));
const max = computed(() => Number(props.data.node.attrs?.max ?? 1));
const value = computed(() => Number(props.data.node.attrs?.value ?? 0.5));
const norm = computed(() => (value.value - min.value) / (max.value - min.value));
// Sweep arc from -135° to +135° (270° total)
const angleDeg = computed(() => -135 + norm.value * 270);

const dragging = ref(false);
let dragStartY = 0;
let dragStartVal = 0;

function onPointerDown(e: PointerEvent) {
  dragging.value = true;
  dragStartY = e.clientY;
  dragStartVal = value.value;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  const dy = dragStartY - e.clientY; // up = positive
  const range = max.value - min.value;
  const v = Math.max(min.value, Math.min(max.value, dragStartVal + (dy / 200) * range));
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: v };
  props.data.onParam(v);
}
function onPointerUp(e: PointerEvent) {
  dragging.value = false;
  (e.target as HTMLElement).releasePointerCapture(e.pointerId);
}
</script>
<template>
  <div class="node-box ui-node dial">
    <div class="header">{{ data.node.type }}<span class="lab" v-if="data.node.attrs?.label">: {{ data.node.attrs.label }}</span></div>
    <div class="body">
      <div
        class="dial-wrap"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
      >
        <svg viewBox="0 0 60 60" width="56" height="56">
          <circle cx="30" cy="30" r="24" fill="#1a1b1e" stroke="#494a52" stroke-width="2" />
          <line
            :x1="30"
            :y1="30"
            :x2="30 + Math.sin((angleDeg * Math.PI) / 180) * 18"
            :y2="30 - Math.cos((angleDeg * Math.PI) / 180) * 18"
            stroke="#00d4aa"
            stroke-width="3"
            stroke-linecap="round"
          />
        </svg>
      </div>
      <span class="val">{{ value.toFixed(3) }}</span>
    </div>
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '50%' }" />
  </div>
</template>
<style scoped>
.dial { min-width: 80px; }
.dial .body { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.dial-wrap { cursor: ns-resize; touch-action: none; }
.val { color: #00d4aa; font-size: 10px; }
.lab { color: #aaa; font-weight: normal; }
</style>
