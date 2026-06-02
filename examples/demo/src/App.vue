<script setup lang="ts"></script>

<template>
  <header class="top">
    <div class="wrap">
      <strong style="font-size: 1.05rem">
        <RouterLink to="/" style="color: var(--fg)">unworklet</RouterLink>
      </strong>
      <span class="muted" style="font-size: 0.85rem">live examples — compiled in your browser</span>
    </div>
  </header>
  <main class="wrap">
    <RouterView :key="$route.fullPath" />
  </main>
</template>
