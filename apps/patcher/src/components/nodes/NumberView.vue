<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { onMounted, onUnmounted, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";
import { runtime } from "../../runtime/runtime-singleton";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef }>>();
const value = ref(0);
let unsubProc: (() => void) | null = null;
let unsubVal: (() => void) | null = null;

function attach() {
  unsubVal?.();
  unsubVal = null;
  const node = runtime.currentNode;
  if (!node) return;
  const slot = node.state[`${props.data.node.id}_val`];
  if (!slot?.subscribe) return;
  unsubVal = slot.subscribe((v: number) => {
    value.value = v;
  });
}

onMounted(() => {
  attach();
  unsubProc = runtime.onProcessorChange(() => attach());
});
onUnmounted(() => {
  unsubVal?.();
  unsubProc?.();
});
</script>

<template>
  <div class="node-box">
    <Handle
      id="in-0"
      class="audio-handle"
      :position="Position.Top"
      type="target"
      :style="{ left: '50%' }"
    />
    <div class="header">number~</div>
    <div class="body num-body">
      <span class="num">{{ value.toFixed(4) }}</span>
    </div>
    <Handle
      id="out-0"
      class="audio-handle"
      :position="Position.Bottom"
      type="source"
      :style="{ left: '50%' }"
    />
  </div>
</template>

<style scoped>
.node-box { min-width: 130px; }
.num-body { padding: 8px 10px; text-align: center; }
.num {
  font-family: "JetBrains Mono", monospace;
  font-size: 16px;
  color: #00d4aa;
}
</style>
