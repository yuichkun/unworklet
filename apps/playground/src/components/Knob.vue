<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  modelValue: number;
  min: number;
  max: number;
  step?: number;
  label?: string;
  unit?: string;
  format?: (v: number) => string;
  exp?: boolean; // exponential mapping
  size?: number;
}>();
const emit = defineEmits<{ "update:modelValue": [v: number] }>();

const size = computed(() => props.size ?? 64);

const norm = computed(() => {
  if (props.exp) {
    const a = Math.log(Math.max(props.min, 1e-6));
    const b = Math.log(Math.max(props.max, 1e-6));
    const v = Math.log(Math.max(props.modelValue, 1e-6));
    return Math.min(1, Math.max(0, (v - a) / (b - a)));
  }
  return Math.min(1, Math.max(0, (props.modelValue - props.min) / (props.max - props.min)));
});

const angle = computed(() => -135 + norm.value * 270);

const dragging = ref(false);
let startY = 0;
let startNorm = 0;

function onPointerDown(e: PointerEvent) {
  (e.target as Element).setPointerCapture(e.pointerId);
  dragging.value = true;
  startY = e.clientY;
  startNorm = norm.value;
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  const dy = startY - e.clientY;
  let n = startNorm + dy / 200;
  if (e.shiftKey) n = startNorm + dy / 800; // fine
  n = Math.min(1, Math.max(0, n));
  let v: number;
  if (props.exp) {
    const a = Math.log(Math.max(props.min, 1e-6));
    const b = Math.log(Math.max(props.max, 1e-6));
    v = Math.exp(a + n * (b - a));
  } else {
    v = props.min + n * (props.max - props.min);
  }
  if (props.step) v = Math.round(v / props.step) * props.step;
  emit("update:modelValue", v);
}
function onPointerUp(e: PointerEvent) {
  dragging.value = false;
  try {
    (e.target as Element).releasePointerCapture(e.pointerId);
  } catch {}
}
function onDoubleClick() {
  // Reset to midpoint (or default if available via prop)
  emit(
    "update:modelValue",
    props.exp ? Math.sqrt(props.min * props.max) : (props.min + props.max) / 2,
  );
}

const display = computed(() => {
  if (props.format) return props.format(props.modelValue);
  const v = props.modelValue;
  const u = props.unit ?? "";
  if (Math.abs(v) >= 100) return `${v.toFixed(0)}${u}`;
  if (Math.abs(v) >= 10) return `${v.toFixed(1)}${u}`;
  if (Math.abs(v) >= 1) return `${v.toFixed(2)}${u}`;
  return `${v.toFixed(3)}${u}`;
});
</script>

<template>
  <div class="knob-wrap" :style="{ width: size + 'px' }">
    <div class="label">{{ label }}</div>
    <div
      class="knob"
      :style="{ width: size + 'px', height: size + 'px' }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDoubleClick"
    >
      <svg :width="size" :height="size" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="var(--bg-2)" stroke="var(--border)" stroke-width="2" />
        <path
          d="M 18 76 A 40 40 0 1 1 82 76"
          fill="none"
          stroke="var(--bg-3)"
          stroke-width="6"
          stroke-linecap="round"
        />
        <path
          d="M 18 76 A 40 40 0 1 1 82 76"
          fill="none"
          stroke="var(--accent)"
          stroke-width="6"
          stroke-linecap="round"
          :stroke-dasharray="`${norm * 188.5} 1000`"
        />
        <line
          x1="50"
          y1="50"
          x2="50"
          y2="22"
          stroke="var(--accent)"
          stroke-width="3"
          stroke-linecap="round"
          :transform="`rotate(${angle} 50 50)`"
        />
      </svg>
    </div>
    <div class="display">{{ display }}</div>
  </div>
</template>

<style scoped>
.knob-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.label {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  text-align: center;
}
.knob {
  cursor: ns-resize;
  user-select: none;
  touch-action: none;
}
.display {
  font-family:
    "JetBrains Mono", "SF Mono", monospace;
  font-size: 11px;
  color: var(--text);
  background: var(--bg-2);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  min-width: 50px;
  text-align: center;
}
</style>
