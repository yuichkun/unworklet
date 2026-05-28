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
        <div class="brand-row">
          <svg
            class="brand-mark"
            viewBox="0 0 24 24"
            width="20"
            height="20"
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
          <span class="brand-name">Unworklet</span>
        </div>
        <span class="brand-sub">Engine Active</span>
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
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 18px 24px;
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-mark {
  color: var(--u-text);
}

.brand-name {
  font-family: var(--u-headline);
  font-weight: 700;
  font-size: 22px;
  letter-spacing: -0.01em;
  color: var(--u-text);
  line-height: 1;
}

.brand-sub {
  font-family: var(--u-mono);
  font-size: 9.5px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--u-text-muted);
  opacity: 0.5;
  padding-left: 28px;
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
