<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { onMounted, onUnmounted, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";
import { runtime } from "../../runtime/runtime-singleton";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef }>>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const W = 220, H = 80;
let latest: Float32Array | null = null;
let unsubProc: (() => void) | null = null;
let unsubBuf: (() => void) | null = null;
let raf: number | null = null;

function attach() {
  unsubBuf?.();
  unsubBuf = null;
  const node = runtime.currentNode;
  if (!node) return;
  const slot = node.state[`${props.data.node.id}_spec`];
  if (!slot?.subscribe) return;
  unsubBuf = slot.subscribe((arr: any) => {
    if (arr instanceof Float32Array) latest = arr;
    else if (ArrayBuffer.isView(arr)) latest = new Float32Array(arr.buffer, arr.byteOffset, arr.byteLength / 4);
  });
}

// Tiny radix-2 FFT — 1024 samples, returns magnitudes 0..N/2.
function fftMag(x: Float32Array): Float32Array {
  const N = 512; // power of two ≤ x.length
  const n = Math.min(N, x.length);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < n; i++) {
    // Hann window
    re[i] = x[i]! * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  // bit reversal
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const tab = (-2 * Math.PI) / size;
    for (let k = 0; k < N; k += size) {
      for (let l = 0; l < half; l++) {
        const ang = tab * l;
        const tr = Math.cos(ang) * re[k + l + half]! - Math.sin(ang) * im[k + l + half]!;
        const ti = Math.cos(ang) * im[k + l + half]! + Math.sin(ang) * re[k + l + half]!;
        re[k + l + half] = re[k + l]! - tr;
        im[k + l + half] = im[k + l]! - ti;
        re[k + l] = re[k + l]! + tr;
        im[k + l] = im[k + l]! + ti;
      }
    }
  }
  const mag = new Float32Array(N >> 1);
  for (let i = 0; i < (N >> 1); i++) {
    mag[i] = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!);
  }
  return mag;
}

function draw() {
  raf = requestAnimationFrame(draw);
  const c = canvasEl.value;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0e0f12";
  ctx.fillRect(0, 0, W, H);
  if (!latest || latest.length === 0) return;
  const mag = fftMag(latest);
  ctx.fillStyle = "#00d4aa";
  // log-scaled bins
  for (let i = 0; i < W; i++) {
    const t = i / W;
    const idx = Math.max(1, Math.floor(Math.exp(t * Math.log(mag.length - 1))));
    const m = mag[idx] ?? 0;
    const norm = Math.min(1, m / 30); // crude scale
    const h = Math.max(1, norm * H);
    ctx.fillRect(i, H - h, 1, h);
  }
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
    <div class="header">spectroscope~</div>
    <div class="body" style="padding: 4px;">
      <canvas ref="canvasEl" :width="W" :height="H" class="spec-canvas" />
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
.spec-canvas {
  display: block;
  background: #0e0f12;
  border: 1px solid #2c2d31;
  border-radius: 3px;
}
</style>
