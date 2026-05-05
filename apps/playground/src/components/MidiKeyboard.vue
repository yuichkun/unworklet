<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  startNote?: number;
  numOctaves?: number;
  velocity?: number;
}>();

const emit = defineEmits<{
  noteOn: [note: number, velocity: number];
  noteOff: [note: number];
}>();

const startNote = computed(() => props.startNote ?? 48); // C3
const numOctaves = computed(() => props.numOctaves ?? 3);
const totalKeys = computed(() => numOctaves.value * 12);

type Key = { note: number; isBlack: boolean; pos: number };

const keys = computed<Key[]>(() => {
  const list: Key[] = [];
  let whiteIdx = 0;
  for (let i = 0; i < totalKeys.value; i++) {
    const note = startNote.value + i;
    const m = note % 12;
    const isBlack = m === 1 || m === 3 || m === 6 || m === 8 || m === 10;
    list.push({ note, isBlack, pos: isBlack ? whiteIdx - 0.35 : whiteIdx });
    if (!isBlack) whiteIdx++;
  }
  return list;
});

const numWhites = computed(() => keys.value.filter((k) => !k.isBlack).length);

const active = ref<Set<number>>(new Set());

function press(note: number, vel = 100) {
  if (active.value.has(note)) return;
  active.value.add(note);
  emit("noteOn", note, props.velocity ?? vel);
}
function release(note: number) {
  if (!active.value.has(note)) return;
  active.value.delete(note);
  emit("noteOff", note);
}

function onPointerDown(note: number, e: PointerEvent) {
  (e.target as Element).setPointerCapture(e.pointerId);
  press(note, 100);
}
function onPointerUp(note: number) {
  release(note);
}
function onPointerEnter(note: number, e: PointerEvent) {
  if (e.buttons & 1) press(note, 100);
}
function onPointerLeave(note: number) {
  release(note);
}

// QWERTY mapping starting at C: a w s e d f t g y h u j k
const qwertyMap: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ";": 16,
};
let qwertyOctave = 4; // C4 = 60

function onKeyDown(e: KeyboardEvent) {
  if (e.repeat) return;
  if (e.key === "z") {
    qwertyOctave = Math.max(0, qwertyOctave - 1);
    return;
  }
  if (e.key === "x") {
    qwertyOctave = Math.min(8, qwertyOctave + 1);
    return;
  }
  const off = qwertyMap[e.key.toLowerCase()];
  if (off === undefined) return;
  const note = qwertyOctave * 12 + 12 + off;
  press(note, 100);
}
function onKeyUp(e: KeyboardEvent) {
  const off = qwertyMap[e.key.toLowerCase()];
  if (off === undefined) return;
  const note = qwertyOctave * 12 + 12 + off;
  release(note);
}
onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
});

defineExpose({ press, release });
</script>

<template>
  <div class="keyboard">
    <div class="info muted">
      QWERTY: A/W/S/E/D/F/T/G/Y/H/U/J... · Z/X = octave down/up
    </div>
    <div class="keys" :style="{ '--white-count': numWhites }">
      <template v-for="k in keys" :key="k.note">
        <div
          v-if="!k.isBlack"
          class="white"
          :class="{ active: active.has(k.note) }"
          :style="{
            left: `${(k.pos / numWhites) * 100}%`,
            width: `${100 / numWhites}%`,
          }"
          @pointerdown="onPointerDown(k.note, $event)"
          @pointerup="onPointerUp(k.note)"
          @pointercancel="onPointerUp(k.note)"
          @pointerenter="onPointerEnter(k.note, $event)"
          @pointerleave="onPointerLeave(k.note)"
        >
          <span v-if="k.note % 12 === 0" class="lbl">C{{ Math.floor(k.note / 12) - 1 }}</span>
        </div>
      </template>
      <template v-for="k in keys" :key="`b${k.note}`">
        <div
          v-if="k.isBlack"
          class="black"
          :class="{ active: active.has(k.note) }"
          :style="{
            left: `calc(${(k.pos / numWhites) * 100}% + ${100 / numWhites / 2 - 4}%)`,
            width: `${(100 / numWhites) * 0.6}%`,
          }"
          @pointerdown="onPointerDown(k.note, $event)"
          @pointerup="onPointerUp(k.note)"
          @pointercancel="onPointerUp(k.note)"
          @pointerenter="onPointerEnter(k.note, $event)"
          @pointerleave="onPointerLeave(k.note)"
        ></div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.keyboard {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.info {
  font-size: 11px;
}
.keys {
  position: relative;
  height: 130px;
  user-select: none;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  touch-action: none;
}
.white {
  position: absolute;
  top: 0;
  bottom: 0;
  background: linear-gradient(to bottom, #f3f4f6 0%, #d3d6df 100%);
  border-right: 1px solid #999;
  cursor: pointer;
  transition: filter 50ms;
}
.white.active {
  filter: brightness(0.6) hue-rotate(-30deg);
  background: linear-gradient(to bottom, var(--accent), var(--accent-2));
}
.white .lbl {
  position: absolute;
  bottom: 4px;
  left: 4px;
  font-size: 10px;
  color: #6c707c;
  pointer-events: none;
}
.black {
  position: absolute;
  top: 0;
  height: 60%;
  background: linear-gradient(to bottom, #1d2030 0%, #0c0d12 100%);
  border-radius: 0 0 4px 4px;
  cursor: pointer;
  z-index: 2;
}
.black.active {
  background: linear-gradient(to bottom, var(--accent) 0%, var(--accent-2) 100%);
}
</style>
