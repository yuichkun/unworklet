<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

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
        <svg
          class="brand-mark"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 12 L6 12 L8 4 L12 20 L14 8 L16 14 L18 12 L22 12"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </svg>
        <span class="brand-name">unworklet</span>
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
  flex: 0 0 168px;
  display: flex;
  flex-direction: column;
  background: var(--u-bg-elev-1);
  border-right: 1px solid var(--u-border);
  padding: 12px 0;
  overflow-y: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 14px 10px;
  border-bottom: 1px solid var(--u-border);
}

.brand-mark {
  color: var(--u-unworklet);
}

.brand-name {
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  color: var(--u-text);
}

.nav {
  display: flex;
  flex-direction: column;
  padding: 6px 6px;
}

.nav-link {
  display: block;
  padding: 5px 10px;
  border-radius: var(--u-radius-sm);
  color: var(--u-text-muted);
  font-size: 11.5px;
  cursor: pointer;
  transition:
    background 100ms,
    color 100ms;
}

.nav-link:hover {
  background: var(--u-bg-elev-2);
  color: var(--u-text);
}

.nav-link.active {
  background: var(--u-bg-elev-3);
  color: var(--u-accent);
  font-weight: 600;
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
