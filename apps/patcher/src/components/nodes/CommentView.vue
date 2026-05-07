<script setup lang="ts">
import type { NodeProps } from "@vue-flow/core";
import { computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";
const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef }>>();
const text = computed(() => String(props.data.node.attrs?.text ?? "comment"));
</script>
<template>
  <div class="comment">{{ text }}</div>
</template>
<style scoped>
.comment {
  color: #aaa;
  font-style: italic;
  font-size: 11px;
  padding: 4px 6px;
  background: transparent;
  border: 1px dashed #494a52;
  border-radius: 2px;
  user-select: text;
}
</style>
