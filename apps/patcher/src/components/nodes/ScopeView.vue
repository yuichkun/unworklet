<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { onMounted, onUnmounted, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";
import { runtime } from "../../runtime/runtime-singleton";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef }>>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const W = 220, H = 60;
let latest: Float32Array | null = null;
let unsubProc: (() => void) | null = null;
let unsubBuf: (() => void) | null = null;
let raf: number | null = null;

function attach() {
  unsubBuf?.();
  unsubBuf = null;
  const node = runtime.currentNode;
  if (!node) return;
  const slot = node.state[`${props.data.node.id}_scope`];
  if (!slot?.subscribe) return;
  unsubBuf = slot.subscribe((arr: any) => {
    if (arr instanceof Float32Array) latest = arr;
    else if (ArrayBuffer.isView(arr)) latest = new Float32Array(arr.buffer, arr.byteOffset, arr.byteLength / 4);
  });
}

function draw() {
  raf = requestAnimationFrame(draw);
  const c = canvasEl.value;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#1a1b1e";
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  if (!latest || latest.length === 0) return;
  ctx.strokeStyle = "#00d4aa";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const N = latest.length;
  for (let i = 0; i < W; i++) {
    const idx = ((i / W) * N) | 0;
    const v = latest[idx] ?? 0;
    const y = H / 2 - Math.max(-1, Math.min(1, v)) * (H / 2 - 2);
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  }
  ctx.stroke();
}

onMounted(() => {
  attach();
  unsubProc = runtime.onProcessorChange(() => attach());
  draw();
});
onUnmounted(() => {
  unsubBuf?.();
  unsubProc?.();
  if (raf != null) cancelAnimationFrame(raf);
});
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
    <div class="header">scope~</div>
    <div class="body" style="padding: 4px;">
      <canvas ref="canvasEl" :width="W" :height="H" class="scope-canvas" />
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
.node-box { min-width: 232px; }
.scope-canvas {
  display: block;
  background: #0e0f12;
  border: 1px solid #2c2d31;
  border-radius: 3px;
}
</style>
