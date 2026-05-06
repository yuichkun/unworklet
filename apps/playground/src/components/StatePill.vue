<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from "vue";
import type { WasmUnworkletNode } from "../audio/createWasmNode";

const props = defineProps<{
  node: WasmUnworkletNode | null;
  slot: string;
  label?: string;
  format?: (v: any) => string;
}>();

const value = ref<any>(null);
let unsub: (() => void) | null = null;

watchEffect(() => {
  if (unsub) {
    unsub();
    unsub = null;
  }
  const n = props.node;
  if (!n) return;
  const slot = n.state[props.slot];
  if (!slot) return;
  value.value = slot.value;
  unsub = slot.subscribe((v) => {
    value.value = v;
  });
});

onBeforeUnmount(() => {
  if (unsub) unsub();
});
</script>

<template>
  <div class="pill">
    <span class="lbl muted">{{ label ?? slot }}</span>
    <span class="val">
      {{ format ? format(value) : (typeof value === "number" ? value.toFixed(3) : value) }}
    </span>
  </div>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-family:
    "JetBrains Mono", "SF Mono", monospace;
  font-size: 11px;
}
.lbl {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 9px;
}
.val {
  color: var(--accent);
}
</style>
