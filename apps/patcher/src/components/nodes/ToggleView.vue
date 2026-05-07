<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void }>>();
const value = computed(() => Number(props.data.node.attrs?.value ?? 0));
function flip() {
  const v = value.value >= 0.5 ? 0 : 1;
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: v };
  props.data.onParam(v);
}
</script>
<template>
  <div class="node-box ui-node">
    <div class="header">{{ data.node.type }}</div>
    <div class="body">
      <button class="toggle-btn" :class="{ on: value >= 0.5 }" @click="flip">
        <span v-if="value >= 0.5">✓</span>
        <span v-else>·</span>
      </button>
    </div>
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '50%' }" />
  </div>
</template>
<style scoped>
.toggle-btn {
  width: 32px; height: 32px;
  background: #1a1b1e;
  border: 2px solid #494a52;
  border-radius: 4px;
  color: #888;
  font-size: 18px;
}
.toggle-btn.on { background: #00d4aa; border-color: #00d4aa; color: #111; }
</style>
