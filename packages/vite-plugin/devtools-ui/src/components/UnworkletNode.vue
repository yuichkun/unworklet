<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";

import type { AudioGraphNode } from "../composables/useMockGraph";

defineProps<{
  data: AudioGraphNode;
  selected: boolean;
}>();
</script>

<template>
  <div class="uw-node" :class="[`kind-${data.kind}`, { selected }]">
    <Handle type="target" :position="Position.Left" :connectable="false" />
    <div class="uw-node-head">
      <span class="uw-node-dot" :class="`status-${data.status}`"></span>
      <span class="uw-node-name" :title="data.label">{{ data.label }}</span>
      <span v-if="data.errorCount > 0" class="uw-node-badge">{{ data.errorCount }}</span>
    </div>
    <div class="uw-node-type" :title="data.audioNodeType">{{ data.audioNodeType }}</div>
    <Handle type="source" :position="Position.Right" :connectable="false" />
  </div>
</template>

<style scoped>
.uw-node {
  width: 140px;
  padding: 8px 12px;
  background: var(--u-bg-elev-2);
  border: 1px solid var(--u-border-strong);
  border-radius: 8px;
  font-family: var(--u-sans);
  color: var(--u-text);
  /* keep node geometry stable when selected (border thickness changes) */
  box-sizing: border-box;
  transition:
    border-color 100ms,
    box-shadow 100ms;
}

.uw-node.kind-unworklet {
  border-color: var(--u-text);
}

.uw-node.selected {
  border-color: var(--u-text);
  box-shadow: 0 0 0 1px var(--u-text);
}

.uw-node-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.uw-node-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--u-text-muted);
  flex-shrink: 0;
}

.uw-node-dot.status-ok {
  background: var(--u-success);
}

.uw-node-dot.status-warning {
  background: var(--u-warn);
}

.uw-node-dot.status-errors {
  background: var(--u-danger);
}

.uw-node-name {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--u-text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.uw-node.kind-unworklet .uw-node-name {
  color: var(--u-text);
}

.uw-node-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  background: var(--u-danger);
  color: #1a1a1a;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  flex-shrink: 0;
}

.uw-node-type {
  margin-top: 4px;
  font-family: var(--u-mono);
  font-size: 9px;
  color: var(--u-text-dim);
  text-align: center;
  letter-spacing: 0.04em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
