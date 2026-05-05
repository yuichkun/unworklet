<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  value: number;
  min?: number;
  max?: number;
  label?: string;
  vertical?: boolean;
}>();

const min = computed(() => props.min ?? 0);
const max = computed(() => props.max ?? 1);
const norm = computed(() =>
  Math.min(1, Math.max(0, (props.value - min.value) / (max.value - min.value))),
);
const color = computed(() => {
  if (norm.value > 0.95) return "var(--error)";
  if (norm.value > 0.8) return "var(--warn)";
  return "var(--accent)";
});
</script>

<template>
  <div class="meter" :class="{ vertical: vertical }">
    <div v-if="label" class="label">{{ label }}</div>
    <div class="bar">
      <div
        class="fill"
        :style="{
          [vertical ? 'height' : 'width']: `${norm * 100}%`,
          background: color,
        }"
      />
    </div>
    <div class="value">{{ value.toFixed(3) }}</div>
  </div>
</template>

<style scoped>
.meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
  min-width: 90px;
}
.meter.vertical {
  flex-direction: column;
  height: 200px;
}
.label {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.bar {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  height: 12px;
  overflow: hidden;
  position: relative;
}
.meter.vertical .bar {
  height: auto;
  flex: 1;
  width: 16px;
  display: flex;
  flex-direction: column-reverse;
}
.fill {
  height: 100%;
  transition: width 50ms linear, background 100ms;
  border-radius: 3px;
}
.value {
  font-family:
    "JetBrains Mono", "SF Mono", monospace;
  font-size: 10px;
  color: var(--text-dim);
  text-align: right;
}
</style>
