<script setup lang="ts">
import { examples } from "../examples.ts";

const fmt = (s: string): string => s.replace(/`([^`]+)`/g, "<code>$1</code>");
</script>

<template>
  <p class="muted">
    Each example is a <code>.uwk.ts</code> processor. The page lowers + compiles it to WebAssembly
    in your browser, plays it live, and recompiles when you edit it.
  </p>
  <RouterLink v-for="ex in examples" :key="ex.slug" :to="`/e/${ex.slug}`" class="card">
    <div class="row" style="justify-content: space-between">
      <strong>{{ ex.title }}</strong>
      <span class="tag">{{ ex.kind }}</span>
    </div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="muted" style="margin-top: 0.35rem; font-size: 0.9rem" v-html="fmt(ex.blurb)"></div>
  </RouterLink>
</template>
