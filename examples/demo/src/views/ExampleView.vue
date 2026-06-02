<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

import { useUnworkletDemo } from "../composables/useUnworkletDemo.ts";
import { exampleBySlug } from "../examples.ts";

const props = defineProps<{ slug: string }>();
const ex = exampleBySlug(props.slug);
const src = ref(ex?.source ?? "");

const { status, error, busy, load, play, stop, testTone, playNote, recompile, loadFile, teardown } =
  useUnworkletDemo();

const NOTES = [60, 62, 64, 65, 67, 69, 71, 72];
const NOTE_LABELS = ["C", "D", "E", "F", "G", "A", "B", "C"];

async function start(): Promise<void> {
  if (!ex) return;
  await load(ex);
  play();
}

async function doRecompile(): Promise<void> {
  await recompile(src.value);
}

function onFile(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
}

onBeforeUnmount(() => {
  void teardown();
});
</script>

<template>
  <p><RouterLink to="/">← all examples</RouterLink></p>
  <template v-if="ex">
    <div class="row" style="justify-content: space-between">
      <h2 style="margin: 0.2rem 0">{{ ex.title }}</h2>
      <span class="tag">{{ ex.kind }}</span>
    </div>

    <textarea v-model="src" class="editor" spellcheck="false"></textarea>

    <div class="row" style="margin-top: 0.7rem">
      <button class="primary" :disabled="busy" @click="start">▶ Play</button>
      <button @click="stop">■ Stop</button>
      <button :disabled="busy" @click="doRecompile">↻ Recompile (crossfade)</button>
      <button
        title="Plain Web Audio oscillator — isolates the AudioContext from the worklet"
        @click="testTone"
      >
        🔊 Test tone
      </button>
    </div>

    <div v-if="ex.kind === 'effect'" class="row" style="margin-top: 0.6rem">
      <span class="muted" style="font-size: 0.85rem"
        >Input: built-in sawtooth, or load a file —</span
      >
      <input type="file" accept="audio/*" @change="onFile" />
    </div>
    <div v-else class="row" style="margin-top: 0.6rem">
      <span class="muted" style="font-size: 0.85rem">Play notes:</span>
      <button v-for="(n, i) in NOTES" :key="n" @click="playNote(n)">{{ NOTE_LABELS[i] }}</button>
    </div>

    <p class="status" style="margin-top: 0.7rem">{{ status }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="renderInfo" class="muted" style="font-size: 0.85rem">
      {{ renderInfo }}
      <a v-if="wavUrl" :href="wavUrl" download="render.wav">download WAV</a>
    </p>
  </template>
  <p v-else>Example not found. <RouterLink to="/">Back</RouterLink></p>
</template>
