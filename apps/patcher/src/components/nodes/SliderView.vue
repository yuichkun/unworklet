<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{
  node: PatchNode;
  def: NodeDef;
  onParam: (v: number) => void;
}>>();

const min = computed(() => Number(props.data.node.attrs?.min ?? props.data.def.paramSpec?.min ?? 0));
const max = computed(() => Number(props.data.node.attrs?.max ?? props.data.def.paramSpec?.max ?? 1));
const value = computed({
  get: () => Number(props.data.node.attrs?.value ?? props.data.def.paramSpec?.default ?? 0),
  set: (v) => {
    const newAttrs = { ...(props.data.node.attrs ?? {}), value: v };
    props.data.node.attrs = newAttrs;
    props.data.onParam(v);
  },
});

function onInput(e: Event) {
  value.value = Number((e.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="node-box ui-node">
    <div class="header">{{ data.node.type }}<span class="lab" v-if="data.node.attrs?.label">: {{ data.node.attrs.label }}</span></div>
    <div class="body slider-body">
      <input
        type="range"
        :min="min"
        :max="max"
        :step="(max - min) / 200"
        :value="value"
        @input="onInput"
      />
      <span class="val">{{ value.toFixed(3) }}</span>
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
.node-box.ui-node { min-width: 180px; }
.slider-body {
  display: flex;
  align-items: center;
  gap: 6px;
}
.slider-body input {
  flex: 1;
}
.val {
  width: 50px;
  text-align: right;
  color: #00d4aa;
  font-size: 10px;
}
.lab { color: #aaa; font-weight: normal; }
</style>
