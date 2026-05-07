<script setup lang="ts">
import { ref, shallowRef, onUnmounted } from "vue";
import { runtime } from "./runtime/runtime-singleton";
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

const status = ref<"idle" | "running" | "error">("idle");
const errMsg = ref("");
const peakValue = ref(0);
const micEnabled = ref(false);
const midiEnabled = ref(false);
const midiInputCount = ref(0);
const midiOutputCount = ref(0);

const patch = ref<Patch>({ nodes: [], cords: [] });
const selectedExample = ref(examples[0]?.file ?? "");
const selectedNode = shallowRef<string | null>(null);

// Subpatch navigation: stack of (patch, breadcrumb-name) pairs. The top of
// the stack is what the canvas currently shows; popping takes you back to
// the parent patcher.
type StackFrame = { patch: Patch; label: string };
const patchStack = ref<StackFrame[]>([]);

let pollInterval: number | null = null;

async function loadExample(file: string) {
  const ex = examples.find((e) => e.file === file);
  if (!ex) return;
  selectedExample.value = file;
  patchStack.value = [];
  patch.value = JSON.parse(JSON.stringify(ex.patch));
  if (status.value === "running") {
    await play();
  }
}

async function enableMic() {
  await runtime.ensureContext();
  const m = await runtime.ensureMic();
  micEnabled.value = m != null;
  if (status.value === "running") await play();
}

async function enableMidi() {
  const access = await runtime.ensureMidi();
  midiEnabled.value = access != null;
  if (access) {
    midiInputCount.value = runtime.midiInputs.length;
    midiOutputCount.value = runtime.midiOutputs.length;
  }
}

function descendIntoSubpatch(nodeId: string, label: string) {
  // Called by PatcherView on double-click. Push current patch onto stack,
  // swap to the inner patch (mutates in-place, keeping reactivity).
  const node = patch.value.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const inner = node.attrs?.patch as Patch | undefined;
  if (!inner) return;
  patchStack.value = [...patchStack.value, { patch: patch.value, label }];
  patch.value = inner;
}

function ascendOneLevel() {
  const last = patchStack.value[patchStack.value.length - 1];
  if (!last) return;
  patchStack.value = patchStack.value.slice(0, -1);
  patch.value = last.patch;
  if (status.value === "running") void play();
}

function ascendTo(index: number) {
  // Pop the stack to the requested depth.
  if (index < 0 || index > patchStack.value.length) return;
  const target = patchStack.value[index];
  if (!target) return;
  patchStack.value = patchStack.value.slice(0, index);
  patch.value = target.patch;
  if (status.value === "running") void play();
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

function onParamChange(nodeId: string, value: number, outletIndex: number = 0, attrName: string = "value") {
  // Update local patch + push to AudioParam without recompile.
  const n = patch.value.nodes.find((nn) => nn.id === nodeId);
  if (!n) return;
  n.attrs = { ...n.attrs, [attrName]: value };
  runtime.setParam(nodeId, value, outletIndex);
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
      <button class="aux" :class="{ active: micEnabled }" @click="enableMic" title="Connect microphone for adc~">
        🎤 {{ micEnabled ? "mic on" : "enable mic" }}
      </button>
      <button class="aux" :class="{ active: midiEnabled }" @click="enableMidi" title="Connect Web MIDI">
        🎹 {{ midiEnabled ? `MIDI ${midiInputCount}/${midiOutputCount}` : "enable MIDI" }}
      </button>
      <span class="status" :class="status">
        {{ status === "running" ? "● live" : status === "error" ? "● error" : "○ idle" }}
      </span>
      <span v-if="status === 'error'" class="err">{{ errMsg }}</span>
      <span class="meter">
        <span class="meter-bar" :style="{ width: Math.min(100, peakValue * 100) + '%' }"></span>
      </span>
    </header>

    <nav v-if="patchStack.length > 0" class="breadcrumb">
      <button class="crumb-btn" @click="ascendTo(0)">▲ root</button>
      <template v-for="(frame, i) in patchStack" :key="i">
        <span class="crumb-sep">/</span>
        <button class="crumb-btn" @click="ascendTo(i + 1)">{{ frame.label }}</button>
      </template>
      <span class="crumb-sep">/</span>
      <span class="crumb-current">(here)</span>
      <button class="crumb-back" @click="ascendOneLevel">← back</button>
    </nav>

    <main class="main">
      <Canvas
        :patch="patch"
        :selected="selectedNode"
        @select="selectedNode = $event"
        @change="onPatchChange"
        @param="(args) => onParamChange(args.nodeId, args.value, args.outletIndex ?? 0, args.attrName ?? 'value')"
        @descend="(args) => descendIntoSubpatch(args.nodeId, args.label)"
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
.aux {
  background: #2c2d31;
  color: #d8d9dc;
  border: 1px solid #3d3e45;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
  font-family: "JetBrains Mono", monospace;
}
.aux.active {
  border-color: #00d4aa;
  color: #00d4aa;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 14px;
  background: #1a1b1e;
  border-bottom: 1px solid #3d3e45;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #888;
}
.crumb-btn {
  background: transparent;
  color: #00d4aa;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
  text-decoration: underline;
}
.crumb-sep { color: #555; }
.crumb-current { color: #d8d9dc; }
.crumb-back {
  margin-left: auto;
  background: #2c2d31;
  color: #d8d9dc;
  border: 1px solid #3d3e45;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
}
.main {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
