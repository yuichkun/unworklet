<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{
  node: PatchNode;
  def: NodeDef;
  onParam: (v: number, outletIndex?: number, attrName?: string) => void;
}>>();

const min = computed(() => Number(props.data.node.attrs?.min ?? props.data.def.paramSpec?.min ?? 0));
const max = computed(() => Number(props.data.node.attrs?.max ?? props.data.def.paramSpec?.max ?? 1));
const value = ref<number>(Number(props.data.node.attrs?.value ?? props.data.def.paramSpec?.default ?? 0));

const angle = computed(() => {
  const t = (value.value - min.value) / (max.value - min.value);
  return -135 + Math.max(0, Math.min(1, t)) * 270;
});

let dragStartY = 0;
let dragStartV = 0;
function onMouseDown(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  dragStartY = e.clientY;
  dragStartV = value.value;
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
function onMove(e: MouseEvent) {
  const dy = dragStartY - e.clientY;
  const range = max.value - min.value;
  const newV = Math.max(min.value, Math.min(max.value, dragStartV + (dy / 200) * range));
  value.value = newV;
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: newV };
  props.data.onParam(newV);
}
function onUp() {
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
}
</script>

<template>
  <div class="node-box ui-node live-dial-box">
    <div class="header">live.dial<span class="lab" v-if="data.node.attrs?.label">: {{ data.node.attrs.label }}</span></div>
    <div class="body live-body">
      <div class="dial-shell" @mousedown="onMouseDown" title="drag vertically">
        <div class="dial-disc">
          <div class="dial-needle" :style="{ transform: `rotate(${angle}deg)` }" />
        </div>
        <div class="val">{{ value.toFixed(3) }}</div>
      </div>
    </div>
    <Handle
      id="out-0"
      class="control-handle"
      :position="Position.Bottom"
      type="source"
      :style="{ left: '50%' }"
    />
  </div>
</template>

<style scoped>
.node-box.ui-node { min-width: 100px; }
.live-dial-box {
  border-color: #ffb84d;
}
.live-body { padding: 8px; }
.dial-shell { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: ns-resize; user-select: none; }
.dial-disc {
  position: relative;
  width: 60px;
  height: 60px;
  background: radial-gradient(circle, #1a1b1e, #0e0f12);
  border: 2px solid #ffb84d;
  border-radius: 50%;
}
.dial-needle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 26px;
  background: #ffd07a;
  transform-origin: 1px 4px;
  transform: rotate(0);
}
.val { color: #ffb84d; font-size: 10px; }
.lab { color: #aaa; font-weight: normal; }
</style>
