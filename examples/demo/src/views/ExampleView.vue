<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

import MonacoEditor from "../components/MonacoEditor.vue";
import { useUnworkletDemo } from "../composables/useUnworkletDemo.ts";
import type { SourceType } from "../composables/useUnworkletDemo.ts";
import { exampleBySlug } from "../examples.ts";

const props = defineProps<{ slug: string }>();
const ex = exampleBySlug(props.slug);
const src = ref(ex?.source ?? "");

const {
  status,
  error,
  ready,
  playing,
  busy,
  params,
  sourceType,
  freq,
  prepare,
  play,
  stop,
  setSource,
  setFreq,
  setParam,
  noteOn,
  noteOff,
  recompile,
  loadFile,
  destroy,
} = useUnworkletDemo();

const WAVES: { value: SourceType; label: string }[] = [
  { value: "sawtooth", label: "Sawtooth" },
  { value: "sine", label: "Sine" },
  { value: "square", label: "Square" },
  { value: "triangle", label: "Triangle" },
  { value: "noise", label: "White noise" },
];

// One octave of white keys, held-to-sound.
const KEYS = [
  { note: 60, label: "C" },
  { note: 62, label: "D" },
  { note: 64, label: "E" },
  { note: 65, label: "F" },
  { note: 67, label: "G" },
  { note: 69, label: "A" },
  { note: 71, label: "B" },
  { note: 72, label: "C" },
];
const down = reactive(new Set<number>());
function press(note: number): void {
  if (down.has(note)) return;
  down.add(note);
  noteOn(note);
}
function release(note: number): void {
  if (down.delete(note)) noteOff(note);
}

function doRecompile(): void {
  void recompile(src.value);
}
function onFile(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
}
function fmtVal(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
}

// Space toggles play / stop for effects — unless you're typing in the editor or a control.
function onGlobalKey(e: KeyboardEvent): void {
  if (e.code !== "Space" || ex?.kind !== "effect" || !ready.value) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, .monaco-host")) return;
  e.preventDefault();
  if (playing.value) stop();
  else void play();
}

onMounted(() => {
  if (ex) void prepare(ex);
  window.addEventListener("keydown", onGlobalKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKey);
  void destroy();
});
</script>

<template>
  <RouterLink to="/" class="crumb">← examples</RouterLink>

  <template v-if="ex">
    <div class="ex-head">
      <h1>{{ ex.title }}</h1>
      <span class="tag" :class="ex.kind">{{ ex.kind }}</span>
    </div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p class="ex-blurb" v-html="ex.blurb.replace(/`([^`]+)`/g, '<code>$1</code>')"></p>

    <div class="workbench">
      <div class="editor-wrap">
        <div class="editor-bar">
          <span class="file">{{ ex.slug }}.uwk.ts</span>
          <span class="label" style="text-transform: none">
            <kbd>⌘</kbd> <kbd>⏎</kbd>&nbsp; recompile
          </span>
        </div>
        <MonacoEditor v-model="src" @submit="doRecompile" />
      </div>

      <div class="panel">
        <div class="panel-block">
          <span class="label">Transport</span>
          <div class="transport">
            <template v-if="ex.kind === 'effect'">
              <button class="primary" :disabled="busy || !ready" @click="play">▶ Play</button>
              <button :disabled="!playing" @click="stop">■ Stop</button>
            </template>
            <button :disabled="busy || !ready" @click="doRecompile">↻ Recompile</button>
          </div>
          <p v-if="ex.kind === 'effect'" class="panel-hint"><kbd>Space</kbd> play / stop</p>
        </div>

        <div v-if="ex.kind === 'effect'" class="panel-block">
          <span class="label">Input source</span>
          <div class="field">
            <select
              :value="sourceType"
              @change="setSource(($event.target as HTMLSelectElement).value as SourceType)"
            >
              <option v-for="w in WAVES" :key="w.value" :value="w.value">{{ w.label }}</option>
            </select>
          </div>
          <div v-if="sourceType !== 'noise'" class="field">
            <div class="field-row">
              <span class="name">freq</span><span class="val">{{ freq.toFixed(0) }} Hz</span>
            </div>
            <input
              type="range"
              min="40"
              max="880"
              step="1"
              :value="freq"
              @input="setFreq(Number(($event.target as HTMLInputElement).value))"
            />
          </div>
          <div class="field">
            <input type="file" accept="audio/*" @change="onFile" />
          </div>
        </div>

        <div v-else class="panel-block">
          <span class="label">Keyboard — hold to play</span>
          <div class="keys">
            <div
              v-for="k in KEYS"
              :key="k.note"
              class="key"
              :class="{ down: down.has(k.note) }"
              @pointerdown="press(k.note)"
              @pointerup="release(k.note)"
              @pointerleave="release(k.note)"
            >
              {{ k.label }}
            </div>
          </div>
        </div>

        <div v-if="params.length" class="panel-block">
          <span class="label">Parameters</span>
          <div v-for="p in params" :key="p.name" class="field">
            <div class="field-row">
              <span class="name">{{ p.name }}</span
              ><span class="val">{{ fmtVal(p.value) }}</span>
            </div>
            <input
              type="range"
              :min="p.min"
              :max="p.max"
              :step="(p.max - p.min) / 100"
              v-model.number="p.value"
              @input="setParam(p.name, p.value)"
            />
          </div>
        </div>

        <p class="status" :class="{ live: playing }"><span class="dot" />{{ status }}</p>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
    </div>
  </template>
  <p v-else>Example not found. <RouterLink to="/">Back to examples</RouterLink></p>
</template>
