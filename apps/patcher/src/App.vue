<script setup lang="ts">
import { ref, shallowRef, onUnmounted } from "vue";
import { AudioRuntime } from "./runtime/AudioRuntime";
import type { Patch } from "./types";
import Canvas from "./components/Canvas.vue";
import InspectorPanel from "./components/InspectorPanel.vue";

// Eager-load all example JSONs at build time.
const exampleModules = import.meta.glob<{ default: { name: string; description?: string; patch: Patch } }>(
  "./examples/*.json",
  { eager: true },
);
const examples = Object.entries(exampleModules)
  .map(([path, mod]) => ({
    file: path.split("/").pop()!,
    name: mod.default.name,
    description: mod.default.description,
    patch: mod.default.patch,
  }))
  .sort((a, b) => a.file.localeCompare(b.file));

const runtime = new AudioRuntime();
const status = ref<"idle" | "running" | "error">("idle");
const errMsg = ref("");
const peakValue = ref(0);

const patch = ref<Patch>({ nodes: [], cords: [] });
const selectedExample = ref(examples[0]?.file ?? "");
const selectedNode = shallowRef<string | null>(null);

let pollInterval: number | null = null;

async function loadExample(file: string) {
  const ex = examples.find((e) => e.file === file);
  if (!ex) return;
  selectedExample.value = file;
  patch.value = JSON.parse(JSON.stringify(ex.patch));
  if (status.value === "running") {
    await play();
  }
}

async function play() {
  try {
    errMsg.value = "";
    await runtime.swap(patch.value);
    status.value = "running";
    startPeakPoll();
  } catch (e: any) {
    status.value = "error";
    errMsg.value = e?.message ?? String(e);
  }
}

async function stop() {
  await runtime.stop();
  status.value = "idle";
  stopPeakPoll();
  peakValue.value = 0;
}

function startPeakPoll() {
  if (pollInterval) return;
  pollInterval = window.setInterval(() => {
    peakValue.value = runtime.getMasterPeak();
  }, 50);
}

function stopPeakPoll() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function onPatchChange() {
  // Hot-swap on any structural change while running.
  if (status.value === "running") {
    void play();
  }
}

function onParamChange(nodeId: string, value: number) {
  // Update local patch + push to AudioParam without recompile.
  const n = patch.value.nodes.find((nn) => nn.id === nodeId);
  if (!n) return;
  n.attrs = { ...n.attrs, value };
  runtime.setParam(nodeId, value);
}

// Boot with the first example loaded so the canvas isn't empty.
if (examples.length) loadExample(examples[0]!.file);

onUnmounted(() => stopPeakPoll());
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <span class="brand">unworklet patcher</span>
      <select v-model="selectedExample" @change="loadExample(selectedExample)" class="example-picker">
        <option v-for="e in examples" :key="e.file" :value="e.file">
          {{ e.name }}
        </option>
      </select>
      <button v-if="status !== 'running'" class="primary" @click="play">▶ play</button>
      <button v-else class="danger" @click="stop">■ stop</button>
      <span class="status" :class="status">
        {{ status === "running" ? "● live" : status === "error" ? "● error" : "○ idle" }}
      </span>
      <span v-if="status === 'error'" class="err">{{ errMsg }}</span>
      <span class="meter">
        <span class="meter-bar" :style="{ width: Math.min(100, peakValue * 100) + '%' }"></span>
      </span>
    </header>

    <main class="main">
      <Canvas
        :patch="patch"
        :selected="selectedNode"
        @select="selectedNode = $event"
        @change="onPatchChange"
        @param="(args) => onParamChange(args.nodeId, args.value)"
      />
      <InspectorPanel
        :patch="patch"
        :selected-id="selectedNode"
        @change="onPatchChange"
      />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: #21222a;
  border-bottom: 1px solid #3d3e45;
  height: 44px;
  flex-shrink: 0;
}
.brand {
  color: #00d4aa;
  font-weight: 700;
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.04em;
}
.example-picker {
  background: #2c2d31;
  color: #d8d9dc;
  border: 1px solid #3d3e45;
  border-radius: 4px;
  padding: 4px 8px;
  min-width: 240px;
}
.status {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
}
.status.running { color: #00d4aa; }
.status.error { color: #ff5577; }
.status.idle { color: #888; }
.err {
  color: #ff8899;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 400px;
}
.meter {
  margin-left: auto;
  display: inline-block;
  width: 200px;
  height: 8px;
  background: #1a1b1e;
  border: 1px solid #3d3e45;
  border-radius: 3px;
  overflow: hidden;
}
.meter-bar {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #00d4aa, #ffb84d, #ff5577);
  transition: width 0.06s linear;
}
.main {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
