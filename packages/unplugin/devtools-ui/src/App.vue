<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

// Inline-SVG via Vite's `?raw` query — the SVG string is dropped into the
// template with v-html so the CSS below can size / restyle the markup
// directly (= no <img> intrinsic-size friction, no extra Vite plugin).
import chainSvg from "./assets/unworklet-logo-chain.svg?raw";
import textSvg from "./assets/unworklet-logo-text.svg?raw";

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
      <div class="brand" aria-label="Unworklet">
        <div class="brand-chain" v-html="chainSvg"></div>
        <div class="brand-text" v-html="textSvg"></div>
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
  padding: 0 10px 18px 22px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
}

/* Chain mark (300×300 viewBox). Tweak `width` to resize. */
.brand-chain {
  width: 32px;
}

/* Wordmark (445.7×77.1 viewBox = aspect 5.78:1). Tweak `width` to resize. */
.brand-text {
  width: 110px;
}

/* v-html injects the <svg> verbatim — these rules make the SVG flow with its
   wrapper instead of relying on the source file's intrinsic width/height
   attributes. `:deep` is required because v-html content is not scoped. */
.brand-chain :deep(svg),
.brand-text :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
  padding: 2px;
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
