<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import logoUrl from "./assets/unworklet-logo.svg";

const router = useRouter();
const route = useRoute();

const navItems = computed(() =>
  router.options.routes
    .filter((r) => typeof r.path === "string" && r.path !== "/")
    .map((r) => ({
      path: r.path,
      label: (r.meta?.label as string) ?? r.path,
      active: route.path.startsWith(r.path),
    })),
);
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-logo" :src="logoUrl" alt="Unworklet" />
      </div>

      <nav class="nav">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-link"
          :class="{ active: item.active }"
        >
          {{ item.label }}
        </router-link>
      </nav>
    </aside>

    <main class="content">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  background: var(--u-bg);
}

.sidebar {
  flex: 0 0 200px;
  display: flex;
  flex-direction: column;
  background: var(--u-bg-elev-2);
  border-right: 1px solid var(--u-border);
  padding: 20px 0 12px;
  overflow-y: auto;
}

.brand {
  padding: 0 18px 24px;
}

/* SVG logo (icon + wordmark baked in, ~537×533 square-ish viewBox). Size
   width-first; height auto preserves the embedded aspect. */
.brand-logo {
  display: block;
  width: 90px;
  height: auto;
}

.nav {
  display: flex;
  flex-direction: column;
  padding: 4px 8px;
  gap: 2px;
}

.nav-link {
  display: block;
  padding: 8px 12px;
  border-radius: var(--u-radius);
  color: var(--u-text-muted);
  font-family: var(--u-sans);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.01em;
  cursor: pointer;
  border-right: 2px solid transparent;
  transition:
    background 100ms,
    color 100ms,
    border-color 100ms;
}

.nav-link:hover {
  background: var(--u-bg-elev-3);
  color: var(--u-text);
}

.nav-link.active {
  background: var(--u-bg-elev-3);
  color: var(--u-text);
  font-weight: 600;
  border-right-color: var(--u-text);
}

.content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 80ms ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
