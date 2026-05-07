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
    props.data.node.attrs = { ...(props.data.node.attrs ?? {}), value: v };
    props.data.onParam(v);
  },
});
function onInput(e: Event) {
  value.value = Number((e.target as HTMLInputElement).value);
}
const pct = computed(() => `${((value.value - min.value) / (max.value - min.value || 1)) * 100}%`);
</script>

<template>
  <div class="node-box ui-node live-slider-box">
    <div class="header">live.slider<span class="lab" v-if="data.node.attrs?.label">: {{ data.node.attrs.label }}</span></div>
    <div class="body live-body">
      <div class="rail">
        <div class="fill" :style="{ width: pct }" />
        <input
          type="range"
          :min="min"
          :max="max"
          :step="(max - min) / 200"
          :value="value"
          @input="onInput"
          class="range"
        />
      </div>
      <div class="val">{{ value.toFixed(3) }}</div>
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
.node-box.ui-node.live-slider-box { min-width: 200px; border-color: #ffb84d; }
.live-body { padding: 8px; }
.rail {
  position: relative;
  height: 16px;
  background: #1a1b1e;
  border: 1px solid #2c2d31;
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, #ffb84d, #ffd07a);
  pointer-events: none;
}
.range {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  background: transparent;
  appearance: none;
  cursor: ew-resize;
  opacity: 0.001;
}
.val { color: #ffb84d; font-size: 10px; text-align: right; margin-top: 2px; }
.lab { color: #aaa; font-weight: normal; }
</style>
