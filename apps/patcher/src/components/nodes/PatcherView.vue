<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";
const props = defineProps<NodeProps<{
  node: PatchNode;
  def: NodeDef;
  onAttrChange: () => void;
  onDescend?: (label: string) => void;
}>>();
const inletCount = computed(() => Number(props.data.node.attrs?.inletCount ?? 2));
const outletCount = computed(() => Number(props.data.node.attrs?.outletCount ?? 2));
const name = computed(() => String(props.data.node.attrs?.name ?? "patcher"));
const innerCount = computed(() => {
  const p = props.data.node.attrs?.patch as any;
  return p?.nodes?.length ?? 0;
});
function onDoubleClick(e: MouseEvent) {
  e.stopPropagation();
  props.data.onDescend?.(name.value);
}
</script>
<template>
  <div class="node-box structural patcher-box" @dblclick="onDoubleClick" title="Double-click to descend into subpatch">
    <Handle
      v-for="i in inletCount"
      :key="`in-${i - 1}`"
      :id="`in-${i - 1}`"
      class="audio-handle"
      :position="Position.Top"
      type="target"
      :style="{ left: `${i * 100 / (inletCount + 1)}%` }"
    />
    <div class="header">📁 patcher: {{ name }}</div>
    <div class="body">
      <span class="muted">{{ innerCount }} inner nodes — double-click to enter</span>
    </div>
    <Handle
      v-for="i in outletCount"
      :key="`out-${i - 1}`"
      :id="`out-${i - 1}`"
      class="audio-handle"
      :position="Position.Bottom"
      type="source"
      :style="{ left: `${i * 100 / (outletCount + 1)}%` }"
    />
  </div>
</template>
<style scoped>
.muted { color: #888; font-size: 10px; }
.patcher-box {
  cursor: pointer;
  border-color: #ffb84d;
}
.patcher-box:hover {
  border-color: #ffd07a;
  background: #2c241a;
}
</style>
