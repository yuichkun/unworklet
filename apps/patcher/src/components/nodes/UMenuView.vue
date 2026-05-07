<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void }>>();
const options = computed<string[]>(() => {
  try {
    const o = JSON.parse(String(props.data.node.attrs?.options ?? "[]"));
    return Array.isArray(o) ? o : [];
  } catch { return []; }
});
const value = computed(() => Number(props.data.node.attrs?.value ?? 0));

function pick(e: Event) {
  const v = Number((e.target as HTMLSelectElement).value);
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: v };
  props.data.onParam(v);
}
</script>
<template>
  <div class="node-box ui-node">
    <div class="header">{{ data.node.type }}</div>
    <div class="body">
      <select :value="value" @change="pick">
        <option v-for="(o, i) in options" :key="i" :value="i">{{ o }}</option>
      </select>
    </div>
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '50%' }" />
  </div>
</template>
<style scoped>
.body select { background: #1a1b1e; color: #d8d9dc; border: 1px solid #494a52; padding: 3px; }
</style>
