<script setup lang="ts">
import { currentBuild } from "./build-info.ts";

const build = currentBuild();
</script>

<template>
  <header class="top">
    <div class="wrap">
      <RouterLink to="/" class="brand">unworklet<span class="brand-dot">.</span></RouterLink>
      <span class="top-tag">live examples</span>
      <span class="top-spacer" />
      <span class="top-tag" :title="build.detail">{{ build.label }}</span>
      <a class="top-tag" href="https://github.com/yuichkun/unworklet" target="_blank" rel="noopener"
        >GitHub ↗</a
      >
    </div>
  </header>
  <main class="wrap">
    <RouterView :key="$route.fullPath" />
  </main>
</template>
