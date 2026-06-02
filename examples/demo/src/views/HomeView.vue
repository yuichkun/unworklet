<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { examples } from "../examples.ts";

const fmt = (s: string): string => s.replace(/`([^`]+)`/g, "<code>$1</code>");

const query = ref("");
const kind = ref<"all" | "effect" | "instrument">("all");
const searchEl = ref<HTMLInputElement | null>(null);

const shown = computed(() =>
  examples.filter((ex) => {
    if (kind.value !== "all" && ex.kind !== kind.value) return false;
    const q = query.value.trim().toLowerCase();
    if (!q) return true;
    return (ex.title + " " + ex.blurb).toLowerCase().includes(q);
  }),
);

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

function onKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchEl.value?.focus();
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <section class="hero">
    <h1 class="headline">Audio DSP you can&nbsp;read.</h1>
    <p class="subhead">
      unworklet compiles a declarative <code>.uwk.ts</code> processor to a WebAssembly AudioWorklet.
      Everything below is real, editable source — change it and it recompiles in your browser and
      crossfades into the running audio, no reload.
    </p>
    <p class="kbd-line">Pick one, press <strong>Play</strong>, and start turning the knobs.</p>
  </section>

  <div class="toolbar">
    <div class="search">
      <span class="icon">⌕</span>
      <input
        ref="searchEl"
        v-model="query"
        type="text"
        placeholder="Search examples…"
        spellcheck="false"
      />
      <kbd class="hint">{{ isMac ? "⌘" : "Ctrl" }} K</kbd>
    </div>
    <div class="filters">
      <button :class="{ active: kind === 'all' }" @click="kind = 'all'">All</button>
      <button :class="{ active: kind === 'effect' }" @click="kind = 'effect'">Effects</button>
      <button :class="{ active: kind === 'instrument' }" @click="kind = 'instrument'">
        Instruments
      </button>
    </div>
  </div>

  <div class="grid">
    <RouterLink v-for="ex in shown" :key="ex.slug" :to="`/e/${ex.slug}`" class="card">
      <div class="card-head">
        <h3>{{ ex.title }}</h3>
        <span class="tag" :class="ex.kind">{{ ex.kind }}</span>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="blurb" v-html="fmt(ex.blurb)"></div>
    </RouterLink>
  </div>
  <p v-if="shown.length === 0" class="muted" style="margin-top: 1.5rem">
    No examples match “{{ query }}”.
  </p>
</template>
