<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  source?: AudioNode | null;
  fftSize?: number;
  height?: number;
  label?: string;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
let analyser: AnalyserNode | null = null;
let raf = 0;
let buf: Float32Array | null = null;

function ensureAnalyser() {
  if (!props.source) return;
  const ctx = props.source.context as AudioContext;
  if (!analyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = props.fftSize ?? 2048;
    buf = new Float32Array(analyser.fftSize);
  }
  try {
    props.source.connect(analyser);
  } catch {}
}
function disconnectAnalyser() {
  if (analyser && props.source) {
    try {
      props.source.disconnect(analyser);
    } catch {}
  }
}

function draw() {
  raf = requestAnimationFrame(draw);
  const c = canvas.value;
  if (!c || !analyser || !buf) return;
  analyser.getFloatTimeDomainData(buf);
  const w = c.width;
  const h = c.height;
  const ctx2d = c.getContext("2d");
  if (!ctx2d) return;
  ctx2d.fillStyle = "#0e0f12";
  ctx2d.fillRect(0, 0, w, h);
  // Center line
  ctx2d.strokeStyle = "#2a2f3f";
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2);
  ctx2d.lineTo(w, h / 2);
  ctx2d.stroke();
  // Waveform
  ctx2d.strokeStyle = "#00d4aa";
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  const slice = w / buf.length;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const y = h / 2 - v * h * 0.45;
    if (i === 0) ctx2d.moveTo(0, y);
    else ctx2d.lineTo(i * slice, y);
  }
  ctx2d.stroke();
}

onMounted(() => {
  ensureAnalyser();
  draw();
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  disconnectAnalyser();
});
watch(
  () => props.source,
  (n, o) => {
    if (o && analyser)
      try {
        o.disconnect(analyser);
      } catch {}
    if (n) ensureAnalyser();
  },
);
</script>

<template>
  <div class="scope">
    <div v-if="label" class="label">{{ label }}</div>
    <canvas ref="canvas" width="600" :height="height ?? 120"></canvas>
  </div>
</template>

<style scoped>
.scope {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}
.label {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}
canvas {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
}
</style>
