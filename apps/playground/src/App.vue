<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { audioState, ensureRunning, audioContext } from "./audio/AudioEngine";

const route = useRoute();
const router = useRouter();
const state = audioState();
const latency = ref(0);
const baseLatency = ref(0);
const sampleRate = ref(0);

watchEffect(() => {
  if (state.value === "running") {
    const ctx = audioContext();
    latency.value = (ctx.outputLatency ?? 0) * 1000;
    baseLatency.value = (ctx.baseLatency ?? 0) * 1000;
    sampleRate.value = ctx.sampleRate;
  }
});

const navItems = computed(() =>
  router
    .getRoutes()
    .filter((r) => r.name && r.name !== "home")
    .map((r) => ({
      path: r.path,
      title: (r.meta?.title as string) || r.path,
      group: groupOf(r.path),
    })),
);

function groupOf(path: string): string {
  if (path.includes("dist") || path.includes("eq") || path.includes("comp") || path.includes("limiter") || path.includes("reverb") || path.includes("delay") || path.includes("chorus") || path.includes("gain")) return "Effects";
  if (path.includes("poly") || path.includes("fm") || path.includes("granular") || path.includes("drum") || path.includes("arp")) return "Instruments";
  return "Misc";
}

const groups = computed(() => {
  const m = new Map<string, typeof navItems.value>();
  for (const it of navItems.value) {
    if (!m.has(it.group)) m.set(it.group, []);
    m.get(it.group)!.push(it);
  }
  return Array.from(m.entries());
});

async function unlockAudio() {
  await ensureRunning();
}
</script>

<template>
  <div class="app">
    <header>
      <RouterLink to="/" class="brand">
        <svg width="24" height="24" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="6" fill="#151517" />
          <path d="M8 8v16M16 8v16M24 8v16" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" />
        </svg>
        <span>unworklet</span>
        <span class="tag">playground</span>
      </RouterLink>
      <div class="status">
        <span class="dot" :class="state"></span>
        <span class="muted">{{ state }}</span>
        <button v-if="state === 'suspended'" class="primary" @click="unlockAudio">▶ Unlock audio</button>
        <span v-if="sampleRate" class="muted">· {{ sampleRate }} Hz</span>
        <span v-if="baseLatency" class="muted">· {{ baseLatency.toFixed(1) }}ms base</span>
        <span v-if="latency" class="muted">· {{ latency.toFixed(1) }}ms out</span>
      </div>
    </header>
    <div class="layout">
      <nav>
        <h3>Showcases</h3>
        <div v-for="[g, items] in groups" :key="g" class="group">
          <div class="group-label">{{ g }}</div>
          <RouterLink
            v-for="i in items"
            :key="i.path"
            :to="i.path"
            class="nav-link"
            :class="{ active: route.path === i.path }"
          >
            {{ i.title }}
          </RouterLink>
        </div>
        <h3>Resources</h3>
        <a class="nav-link" href="https://github.com/yuichkun/unworklet" target="_blank">GitHub</a>
      </nav>
      <main>
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 22px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  color: var(--text);
  text-decoration: none;
}
.status {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
}
.dot.running {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}
.dot.suspended {
  background: var(--warn);
}

.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  flex: 1;
}
nav {
  border-right: 1px solid var(--border);
  background: var(--bg-2);
  padding: 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}
nav h3 {
  margin-top: 0;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.group-label {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 4px 8px;
}
.nav-link {
  display: block;
  padding: 7px 10px;
  border-radius: 5px;
  color: var(--text-dim);
  font-size: 13px;
}
.nav-link:hover {
  background: var(--bg-3);
  color: var(--text);
}
.nav-link.active {
  background: var(--bg-3);
  color: var(--accent);
}
main {
  padding: 22px 28px;
  overflow-y: auto;
}
</style>
