<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void; onAttrChange: () => void }>>();
const count = computed(() => Number(props.data.node.attrs?.count ?? 8));
const min = computed(() => Number(props.data.node.attrs?.min ?? 0));
const max = computed(() => Number(props.data.node.attrs?.max ?? 1));
const values = computed<number[]>(() => {
  try {
    const v = JSON.parse(String(props.data.node.attrs?.values ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
});

function setValue(idx: number, v: number) {
  const arr = values.value.slice();
  arr[idx] = v;
  while (arr.length < count.value) arr.push((min.value + max.value) / 2);
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), values: JSON.stringify(arr) };
  props.data.onAttrChange();
}
</script>
<template>
  <div class="node-box ui-node">
    <div class="header">{{ data.node.type }}</div>
    <div class="body multi">
      <div v-for="i in count" :key="i" class="bar-wrap">
        <input
          type="range"
          class="bar"
          :min="min"
          :max="max"
          :step="(max - min) / 100"
          :value="values[i - 1] ?? 0.5"
          @input="(e) => setValue(i - 1, Number((e.target as HTMLInputElement).value))"
        />
      </div>
    </div>
    <Handle id="in-0" class="control-handle" :position="Position.Top" type="target" :style="{ left: '50%' }" />
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '50%' }" />
  </div>
</template>
<style scoped>
.multi { display: flex; gap: 1px; padding: 4px; }
.bar-wrap { display: flex; align-items: center; }
.bar { writing-mode: bt-lr; appearance: slider-vertical; width: 12px; height: 60px; }
</style>
