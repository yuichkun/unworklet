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
let buf: Uint8Array | null = null;

function ensureAnalyser() {
  if (!props.source) return;
  const ctx = props.source.context as AudioContext;
  if (!analyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = props.fftSize ?? 2048;
    analyser.smoothingTimeConstant = 0.6;
    buf = new Uint8Array(analyser.frequencyBinCount);
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
  analyser.getByteFrequencyData(buf);
  const w = c.width;
  const h = c.height;
  const ctx2d = c.getContext("2d");
  if (!ctx2d) return;
  ctx2d.fillStyle = "#0e0f12";
  ctx2d.fillRect(0, 0, w, h);
  const sr = (props.source?.context as AudioContext).sampleRate;
  const nyquist = sr / 2;
  // Logarithmic bin mapping (20Hz..20kHz)
  const minF = 20;
  const maxF = Math.min(20000, nyquist);
  const logMin = Math.log(minF);
  const logMax = Math.log(maxF);
  for (let x = 0; x < w; x++) {
    const f = Math.exp(logMin + (x / w) * (logMax - logMin));
    const bin = Math.min(buf.length - 1, Math.round((f / nyquist) * buf.length));
    const v = buf[bin]! / 255;
    const barH = v * h;
    const grad = ctx2d.createLinearGradient(0, h, 0, h - barH);
    grad.addColorStop(0, "#00d4aa");
    grad.addColorStop(0.7, "#66e3c9");
    grad.addColorStop(1, "#ff8a4c");
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(x, h - barH, 1, barH);
  }
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
  <div class="spec">
    <div v-if="label" class="label">{{ label }}</div>
    <canvas ref="canvas" width="600" :height="height ?? 140"></canvas>
  </div>
</template>

<style scoped>
.spec {
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
