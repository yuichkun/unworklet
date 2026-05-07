<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { onMounted, onUnmounted, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";
import { runtime } from "../../runtime/runtime-singleton";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef }>>();

const peak = ref(0);
const peakHold = ref(0);
let unsubProc: (() => void) | null = null;
let unsubVal: (() => void) | null = null;
let holdTimer = 0;

function attach() {
  unsubVal?.();
  unsubVal = null;
  const node = runtime.currentNode;
  if (!node) return;
  const slot = node.state[`${props.data.node.id}_peak`];
  if (!slot?.subscribe) return;
  unsubVal = slot.subscribe((v: number) => {
    const p = Math.max(0, Math.min(1.5, v));
    peak.value = p;
    if (p > peakHold.value) {
      peakHold.value = p;
      holdTimer = performance.now();
    }
  });
}

let raf: number | null = null;
function tick() {
  raf = requestAnimationFrame(tick);
  if (peakHold.value > 0 && performance.now() - holdTimer > 1000) {
    peakHold.value = Math.max(0, peakHold.value - 0.02);
  }
}

onMounted(() => {
  attach();
  unsubProc = runtime.onProcessorChange(() => attach());
  tick();
});
onUnmounted(() => {
  unsubVal?.();
  unsubProc?.();
  if (raf != null) cancelAnimationFrame(raf);
});

// Convert 0..1 → 0..100 px width.
function pct(v: number) {
  return Math.min(100, Math.max(0, v * 100)).toFixed(1) + "%";
}
function db(v: number) {
  if (v <= 0.0001) return "-∞ dB";
  const x = 20 * Math.log10(v);
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)} dB`;
}
</script>

<template>
  <div class="node-box">
    <Handle
      id="in-0"
      class="audio-handle"
      :position="Position.Top"
      type="target"
      :style="{ left: '50%' }"
    />
    <div class="header">meter~</div>
    <div class="body meter-body">
      <div class="rail">
        <div class="bar" :style="{ width: pct(peak) }" />
        <div class="hold" :style="{ left: pct(peakHold) }" />
      </div>
      <div class="db">{{ db(peak) }}</div>
    </div>
    <Handle
      id="out-0"
      class="audio-handle"
      :position="Position.Bottom"
      type="source"
      :style="{ left: '50%' }"
    />
  </div>
</template>

<style scoped>
.node-box { min-width: 200px; }
.meter-body { padding: 4px 6px; }
.rail {
  position: relative;
  height: 10px;
  background: #0e0f12;
  border: 1px solid #2c2d31;
  border-radius: 3px;
  overflow: hidden;
}
.bar {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, #00d4aa 0%, #ffb84d 70%, #ff5577 95%);
  transition: width 0.04s linear;
}
.hold {
  position: absolute;
  top: -1px; bottom: -1px;
  width: 2px;
  background: #fff;
}
.db {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #00d4aa;
  text-align: right;
  margin-top: 2px;
}
</style>
