<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef }>>();

const argLabel = computed(() => {
  const a = props.data.node.args ?? props.data.def.defaultArgs ?? [];
  if (!a.length) return "";
  return " " + a.map((x) => String(x)).join(" ");
});

const headerClass = computed(() => {
  const cat = props.data.def.category;
  if (cat === "structural") return "structural";
  return "";
});
</script>

<template>
  <div class="node-box" :class="headerClass">
    <Handle
      v-for="(p, i) in data.def.inlets"
      :key="`in-${i}`"
      :id="`in-${i}`"
      :class="p.kind === 'audio' ? 'audio-handle' : 'control-handle'"
      :position="Position.Top"
      type="target"
      :style="{ left: `${(i + 1) * 100 / (data.def.inlets.length + 1)}%` }"
    />
    <div class="header">
      {{ data.node.type }}<span class="args">{{ argLabel }}</span>
    </div>
    <div class="body" v-if="data.def.category !== 'structural'">
      <span class="muted">{{ data.def.outlets.length }} out · {{ data.def.inlets.length }} in</span>
    </div>
    <Handle
      v-for="(p, i) in data.def.outlets"
      :key="`out-${i}`"
      :id="`out-${i}`"
      :class="p.kind === 'audio' ? 'audio-handle' : 'control-handle'"
      :position="Position.Bottom"
      type="source"
      :style="{ left: `${(i + 1) * 100 / (data.def.outlets.length + 1)}%` }"
    />
  </div>
</template>

<style scoped>
.node-box {
  min-width: 100px;
}
.args {
  color: #aaa;
  font-weight: normal;
}
.muted {
  color: #888;
  font-size: 10px;
}
</style>
