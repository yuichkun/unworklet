<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useMockGraph } from "./composables/useMockGraph";

const router = useRouter();
const route = useRoute();

const graph = useMockGraph();

const navItems = computed(() =>
  router.options.routes
    .filter((r) => typeof r.path === "string" && r.path !== "/")
    .map((r) => ({
      path: r.path,
      label: (r.meta?.label as string) ?? r.path,
      icon: (r.meta?.icon as string) ?? "",
      active: route.path.startsWith(r.path),
    })),
);

const handleNodeClick = (id: string): void => {
  graph.selectNode(id);
  if (!route.path.startsWith("/audio-graph")) {
    void router.push("/audio-graph");
  }
};
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <svg
          class="brand-mark"
          viewBox="0 0 24 24"
          width="22"
          height="22"
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
        <div class="brand-text">
          <div class="brand-name">unworklet</div>
          <div class="brand-sub">DevTools</div>
        </div>
      </div>

      <nav class="nav">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-link"
          :class="{ active: item.active }"
        >
          <span class="nav-icon" :data-icon="item.icon"></span>
          <span class="nav-label">{{ item.label }}</span>
        </router-link>
      </nav>

      <div class="section-title">processors</div>
      <ul class="node-list">
        <li
          v-for="node in graph.nodes"
          :key="node.id"
          class="node-item"
          :class="[`kind-${node.kind}`, { active: graph.selectedId.value === node.id }]"
          @click="handleNodeClick(node.id)"
        >
          <span class="node-dot" :class="`status-${node.status}`"></span>
          <span class="node-label">{{ node.label }}</span>
          <span v-if="node.errorCount > 0" class="node-badge">{{ node.errorCount }}</span>
        </li>
      </ul>

      <div class="footer">
        <div class="footer-row">
          <span class="footer-key">transport</span>
          <span class="footer-val">sab</span>
        </div>
        <div class="footer-row">
          <span class="footer-key">audio ctx</span>
          <span class="footer-val">48 kHz</span>
        </div>
      </div>
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
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  background: var(--u-bg-elev-1);
  border-right: 1px solid var(--u-border);
  padding: 16px 0;
  overflow-y: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px 14px;
  border-bottom: 1px solid var(--u-border);
}

.brand-mark {
  color: var(--u-unworklet);
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-name {
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.02em;
}

.brand-sub {
  font-size: 10px;
  color: var(--u-text-dim);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.nav {
  display: flex;
  flex-direction: column;
  padding: 12px 8px;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--u-radius-sm);
  color: var(--u-text-muted);
  font-size: 12.5px;
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

.nav-icon {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: currentColor;
  opacity: 0.45;
  flex-shrink: 0;
}

.nav-link.active .nav-icon {
  opacity: 0.85;
}

.section-title {
  padding: 8px 18px 4px;
  font-size: 10px;
  color: var(--u-text-dim);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.node-list {
  list-style: none;
  margin: 0;
  padding: 4px 8px 12px;
}

.node-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: var(--u-radius-sm);
  font-family: var(--u-mono);
  font-size: 12px;
  color: var(--u-text-muted);
  cursor: pointer;
  transition: background 100ms;
}

.node-item:hover {
  background: var(--u-bg-elev-2);
  color: var(--u-text);
}

.node-item.active {
  background: var(--u-bg-elev-3);
}

.node-item.active .node-label {
  font-weight: 700;
}

.node-item.kind-unworklet .node-label {
  color: var(--u-unworklet);
}

.node-item.kind-standard .node-label {
  color: var(--u-text-muted);
}

.node-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.node-dot.status-ok {
  background: var(--u-success);
}

.node-dot.status-errors {
  background: var(--u-danger);
}

.node-dot.status-warning {
  background: var(--u-warn);
}

.node-label {
  flex: 1;
}

.node-badge {
  background: var(--u-danger);
  color: var(--u-bg);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
  font-family: var(--u-sans);
}

.footer {
  margin-top: auto;
  padding: 12px 18px;
  border-top: 1px solid var(--u-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.footer-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}

.footer-key {
  color: var(--u-text-dim);
}

.footer-val {
  color: var(--u-text-muted);
  font-family: var(--u-mono);
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
