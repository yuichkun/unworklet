<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void }>>();

function bang() {
  props.data.onParam(1);
  // Decay the param back to 0 after ~30 ms so the next bang is detectable.
  setTimeout(() => props.data.onParam(0), 30);
}
</script>
<template>
  <div class="node-box ui-node">
    <div class="header">{{ data.node.type }}</div>
    <div class="body">
      <button class="bang-btn" @click="bang">●</button>
    </div>
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '50%' }" />
  </div>
</template>
<style scoped>
.bang-btn {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: #ffb84d;
  color: #111;
  border: 1px solid #ffb84d;
  font-size: 18px;
  cursor: pointer;
}
.bang-btn:hover { background: #ffd070; }
</style>
