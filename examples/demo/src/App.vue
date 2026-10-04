<script setup lang="ts">
const buildLabel = __DEMO_BUILD_LABEL__;
</script>

<template>
  <header class="top">
    <div class="wrap">
      <RouterLink to="/" class="brand">unworklet<span class="brand-dot">.</span></RouterLink>
      <span class="top-tag">live examples</span>
      <span class="top-spacer" />
      <a class="top-tag" href="https://github.com/yuichkun/unworklet" target="_blank" rel="noopener"
        >GitHub ↗</a
      >
    </div>
  </header>
  <main class="wrap">
    <RouterView :key="$route.fullPath" />
  </main>
  <footer class="wrap build-version" data-testid="build-version">{{ buildLabel }}</footer>
</template>
