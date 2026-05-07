<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void }>>();
const value = computed(() => Number(props.data.node.attrs?.value ?? 0));
const editing = ref(false);
const editValue = ref("");

function startEdit() {
  editing.value = true;
  editValue.value = String(value.value);
}
function commit() {
  const v = Number(editValue.value);
  if (Number.isFinite(v)) {
    props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: v };
    props.data.onParam(v);
  }
  editing.value = false;
}

let dragStartY = 0, dragStartVal = 0, dragging = false;
function onPointerDown(e: PointerEvent) {
  if (editing.value) return;
  dragStartY = e.clientY;
  dragStartVal = value.value;
  dragging = true;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!dragging) return;
  const dy = dragStartY - e.clientY;
  const v = dragStartVal + dy * 0.1;
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: v };
  props.data.onParam(v);
}
function onPointerUp() { dragging = false; }
</script>
<template>
  <div class="node-box ui-node">
    <div class="header">{{ data.node.type }}</div>
    <div class="body">
      <input
        v-if="editing"
        type="number"
        v-model="editValue"
        @keydown.enter="commit"
        @blur="commit"
        autofocus
      />
      <div
        v-else
        class="num"
        @dblclick="startEdit"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
      >{{ value.toFixed(3) }}</div>
    </div>
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '50%' }" />
  </div>
</template>
<style scoped>
.num { font-family: "JetBrains Mono", monospace; cursor: ns-resize; padding: 2px 6px; user-select: none; touch-action: none; }
.body input { width: 100%; }
</style>
