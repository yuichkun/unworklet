<script setup lang="ts">
import { computed, useTemplateRef } from "vue";

/**
 * Custom pointer-driven slider for the MIDI inject panel. Replaces native
 * `<input type="range">` because the native control's drag tracking gets
 * disrupted when Vue re-renders the surrounding tree mid-drag (= happens
 * whenever auto-send pushes a log entry on every emitted value).
 *
 * Uses `setPointerCapture` (= the trick from vue-bits ElasticSlider) so the
 * pointer stays bound to this element until release, regardless of what the
 * DOM around it does. Emits `update:modelValue` continuously during drag,
 * and `release` once on pointer-up (= used by pitch bend for spring-return).
 */

interface Props {
  modelValue: number;
  min: number;
  max: number;
  /** When true, the fill grows symmetrically out from the track center.
      Use for bi-polar values like pitch bend (-8192…0…+8191). */
  centerOrigin?: boolean;
}

const props = withDefaults(defineProps<Props>(), { centerOrigin: false });
const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
  (e: "release"): void;
}>();

const trackRef = useTemplateRef<HTMLDivElement>("trackRef");

const norm = computed(() => {
  const range = props.max - props.min;
  if (range === 0) return 0;
  const n = (props.modelValue - props.min) / range;
  return Math.max(0, Math.min(1, n));
});

const fillStyle = computed(() => {
  const pct = norm.value * 100;
  if (props.centerOrigin) {
    const center = 50;
    const left = Math.min(center, pct);
    const width = Math.abs(pct - center);
    return { left: `${left}%`, width: `${width}%` };
  }
  return { left: "0%", width: `${pct}%` };
});

const thumbStyle = computed(() => ({ left: `${norm.value * 100}%` }));

const computeValueFromX = (clientX: number): number => {
  const track = trackRef.value;
  if (!track) return props.modelValue;
  const { left, width } = track.getBoundingClientRect();
  if (width === 0) return props.modelValue;
  const t = Math.max(0, Math.min(1, (clientX - left) / width));
  const raw = props.min + t * (props.max - props.min);
  // Snap to integers — MIDI values are all integers in their respective ranges.
  return Math.round(raw);
};

const onPointerDown = (event: PointerEvent): void => {
  if (event.button !== 0) return;
  // Guarded — synthetic events from tests can throw `InvalidPointerId` because
  // the browser never registered the pointer; real user input always succeeds.
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    /* no-op */
  }
  emit("update:modelValue", computeValueFromX(event.clientX));
};

const onPointerMove = (event: PointerEvent): void => {
  // Only act while the primary button is held (= we have pointer capture).
  // `buttons` is a bitmask: bit 0 = primary (left mouse / touch).
  if ((event.buttons & 1) === 0) return;
  emit("update:modelValue", computeValueFromX(event.clientX));
};

const onPointerUp = (event: PointerEvent): void => {
  const el = event.currentTarget as HTMLElement;
  if (el.hasPointerCapture?.(event.pointerId)) {
    el.releasePointerCapture(event.pointerId);
  }
  emit("release");
};
</script>

<template>
  <div
    ref="trackRef"
    class="midi-slider"
    :class="{ 'midi-slider--center': centerOrigin }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="midi-slider-track"></div>
    <div v-if="centerOrigin" class="midi-slider-center-tick"></div>
    <div class="midi-slider-fill" :style="fillStyle"></div>
    <div class="midi-slider-thumb" :style="thumbStyle"></div>
  </div>
</template>

<style scoped>
.midi-slider {
  position: relative;
  width: 100%;
  height: 22px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.midi-slider:active {
  cursor: grabbing;
}

.midi-slider-track {
  position: absolute;
  inset: 9px 0;
  height: 4px;
  background: var(--u-bg-elev-3);
  border: 1px solid var(--u-border);
  border-radius: 2px;
  pointer-events: none;
}

.midi-slider-fill {
  position: absolute;
  top: 9px;
  height: 4px;
  background: var(--u-text-muted);
  border-radius: 2px;
  pointer-events: none;
}

.midi-slider--center .midi-slider-fill {
  background: var(--u-text);
  opacity: 0.7;
}

.midi-slider-center-tick {
  position: absolute;
  top: 6px;
  left: 50%;
  width: 1px;
  height: 10px;
  background: var(--u-border-strong);
  transform: translateX(-0.5px);
  pointer-events: none;
}

.midi-slider-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--u-text);
  border: 1px solid var(--u-border-strong);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: transform 80ms ease-out;
}

.midi-slider:hover .midi-slider-thumb,
.midi-slider:active .midi-slider-thumb {
  transform: translate(-50%, -50%) scale(1.15);
}
</style>
