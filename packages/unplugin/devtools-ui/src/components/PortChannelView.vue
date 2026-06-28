<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import { useLiveSignals } from "../composables/useLiveSignals";
import { VIRIDIS_LUT_256 } from "../lib/viridis";

/**
 * Live visualization (oscilloscope + rolling spectrogram + level meter) for one
 * unworklet output port. Data is the real AnalyserNode tap streamed through
 * `useLiveSignals`; every visual is drawn on canvas inside this component's own
 * rAF loop reading the latest non-reactive frame, so the panel never re-renders
 * per audio frame.
 */

interface Props {
  nodeId: string;
  portName: string;
}
const props = defineProps<Props>();

const signals = useLiveSignals();

const WAVE_COLOR = "#5fa8ff";

const waveformCanvasRef = ref<HTMLCanvasElement | null>(null);
const spectrogramCanvasRef = ref<HTMLCanvasElement | null>(null);
const meterFillRef = ref<HTMLElement | null>(null);
const peakFillRef = ref<HTMLElement | null>(null);
const levelLabelRef = ref<HTMLElement | null>(null);

const dbfs = (amp: number): number => (amp <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(amp));
const fmtDb = (db: number): string => (db === Number.NEGATIVE_INFINITY ? "-∞" : db.toFixed(1));
// Map dBFS over [-60, 0] onto [0, 1] for the meter bar width.
const METER_FLOOR_DB = -60;
const dbToFrac = (db: number): number => {
  if (db === Number.NEGATIVE_INFINITY) return 0;
  const f = (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
  return f < 0 ? 0 : f > 1 ? 1 : f;
};

const drawWaveform = (canvas: HTMLCanvasElement, time: number[]): void => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 110;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(168, 172, 184, 0.18)";
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const n = time.length;
  if (n === 0) return;
  const halfH = h / 2 - 4;
  const center = h / 2;
  const samplesPerPixel = n / w;

  ctx.strokeStyle = WAVE_COLOR;
  ctx.beginPath();
  if (samplesPerPixel <= 1) {
    // Fewer samples than pixels: polyline through every sample exactly.
    ctx.lineWidth = 1.4;
    const xDen = Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / xDen) * w;
      const y = center - Math.max(-1, Math.min(1, time[i]!)) * halfH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    // Per-pixel min/max bar = honest live-scope rendering (no curve fitting).
    ctx.lineWidth = 1;
    for (let px = 0; px < w; px++) {
      const start = Math.floor(px * samplesPerPixel);
      const end = Math.min(n, Math.floor((px + 1) * samplesPerPixel));
      let min = 1;
      let max = -1;
      for (let s = start; s < end; s++) {
        const v = time[s]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yTop = center - Math.max(-1, Math.min(1, max)) * halfH;
      const yBottom = center - Math.max(-1, Math.min(1, min)) * halfH;
      ctx.moveTo(px + 0.5, yTop);
      ctx.lineTo(px + 0.5, yBottom);
    }
  }
  ctx.stroke();
};

const drawSpectrogram = (canvas: HTMLCanvasElement, freq: number[]): void => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 110;
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const stripPx = Math.max(2, Math.round(2 * dpr));
  // Scroll the existing image left by one strip, then paint the new column.
  const existing = ctx.getImageData(stripPx, 0, canvas.width - stripPx, canvas.height);
  ctx.putImageData(existing, 0, 0);
  ctx.clearRect(canvas.width - stripPx, 0, stripPx, canvas.height);

  const bins = freq.length;
  if (bins === 0) return;
  const lutMax = VIRIDIS_LUT_256.length - 1;
  for (let i = 0; i < bins; i++) {
    // Low frequencies at the bottom of the column.
    const v = Math.max(0, Math.min(1, freq[bins - 1 - i]!));
    const y = (i / bins) * canvas.height;
    const cellH = canvas.height / bins + 1;
    ctx.fillStyle = VIRIDIS_LUT_256[Math.round(v * lutMax)]!;
    ctx.fillRect(canvas.width - stripPx, y, stripPx, cellH);
  }
};

const updateMeter = (rms: number, peak: number): void => {
  if (meterFillRef.value)
    meterFillRef.value.style.width = `${(dbToFrac(dbfs(rms)) * 100).toFixed(1)}%`;
  if (peakFillRef.value)
    peakFillRef.value.style.left = `${(dbToFrac(dbfs(peak)) * 100).toFixed(1)}%`;
  if (levelLabelRef.value) {
    levelLabelRef.value.textContent = `rms ${fmtDb(dbfs(rms))} · peak ${fmtDb(dbfs(peak))} dBFS`;
  }
};

let rafId: number | null = null;
const loop = (): void => {
  const frame = signals.getFrame(props.nodeId, props.portName);
  if (waveformCanvasRef.value) drawWaveform(waveformCanvasRef.value, frame?.time ?? []);
  if (spectrogramCanvasRef.value) drawSpectrogram(spectrogramCanvasRef.value, frame?.freq ?? []);
  updateMeter(frame?.rms ?? 0, frame?.peak ?? 0);
  rafId = requestAnimationFrame(loop);
};

onMounted(() => {
  rafId = requestAnimationFrame(loop);
});
onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
});
</script>

<template>
  <div class="port-channel-view">
    <div class="level-row">
      <div class="level-track">
        <div ref="meterFillRef" class="level-fill"></div>
        <div ref="peakFillRef" class="level-peak"></div>
      </div>
      <span ref="levelLabelRef" class="level-label mono">rms -∞ · peak -∞ dBFS</span>
    </div>
    <div class="channel-canvases">
      <div class="canvas-block">
        <header class="canvas-head">
          <span class="canvas-title">Waveform</span>
          <span class="canvas-meta mono">time domain · live</span>
        </header>
        <canvas ref="waveformCanvasRef" class="waveform-canvas"></canvas>
      </div>
      <div class="canvas-block">
        <header class="canvas-head">
          <span class="canvas-title">Spectrogram</span>
          <span class="canvas-meta mono">freq domain · rolling</span>
        </header>
        <canvas ref="spectrogramCanvasRef" class="spectrogram-canvas"></canvas>
      </div>
    </div>
  </div>
</template>

<style scoped>
.port-channel-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.level-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.level-track {
  position: relative;
  height: 8px;
  background: var(--u-bg-elev-3);
  border-radius: 4px;
  overflow: hidden;
}

.level-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--u-success), var(--u-accent));
  border-radius: 4px;
  transition: width 60ms linear;
}

.level-peak {
  position: absolute;
  top: -1px;
  bottom: -1px;
  left: 0%;
  width: 2px;
  background: var(--u-text);
}

.level-label {
  font-size: 10.5px;
  color: var(--u-text-muted);
  white-space: nowrap;
}

.channel-canvases {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.canvas-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.canvas-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.canvas-title {
  font-size: 11px;
  color: var(--u-text-muted);
}

.canvas-meta {
  font-size: 10.5px;
  color: var(--u-text-dim);
}

.waveform-canvas,
.spectrogram-canvas {
  width: 100%;
  height: 110px;
  background-color: var(--u-bg);
  background-image:
    linear-gradient(rgba(255, 250, 240, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 250, 240, 0.04) 1px, transparent 1px);
  background-size: 40px 40px;
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
}
</style>
