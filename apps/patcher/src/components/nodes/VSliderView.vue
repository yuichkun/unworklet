<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void }>>();
const min = computed(() => Number(props.data.node.attrs?.min ?? 0));
const max = computed(() => Number(props.data.node.attrs?.max ?? 1));
const value = computed({
  get: () => Number(props.data.node.attrs?.value ?? 0.5),
  set: (v) => {
    props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: v };
    props.data.onParam(v);
  },
});
</script>
<template>
  <div class="node-box ui-node vslider">
    <div class="header">{{ data.node.type }}</div>
    <div class="body">
      <input
        type="range"
        class="vslider-input"
        :min="min"
        :max="max"
        :step="(max - min) / 200"
        :value="value"
        @input="(e) => (value = Number((e.target as HTMLInputElement).value))"
      />
      <div class="val">{{ value.toFixed(2) }}</div>
    </div>
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '50%' }" />
  </div>
</template>
<style scoped>
.vslider { min-width: 60px; }
.vslider .body { display: flex; flex-direction: column; align-items: center; gap: 4px; height: 120px; }
.vslider-input { writing-mode: bt-lr; appearance: slider-vertical; width: 22px; height: 100px; }
.val { color: #00d4aa; font-size: 10px; }
</style>
