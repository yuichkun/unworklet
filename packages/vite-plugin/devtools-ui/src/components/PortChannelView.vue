<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import RangeSlider from "./RangeSlider.vue";
import { type OutputPort, useMockSignals } from "../composables/useMockSignals";
import { VIRIDIS_LUT_256 } from "../lib/viridis";

/**
 * Single-channel visualization (waveform + spectrogram) for one (port, channel)
 * pair. Extracted from SignalsView so the parent can compose multiple instances
 * per port if/when the user wants to inspect more than ch 0.
 *
 * Each instance owns its own rAF loop — at <10 channels total the overhead is
 * trivial, and the encapsulation means callers don't need to wire canvas refs
 * upward.
 */

interface Props {
  port: OutputPort;
  channelIndex: number;
}
const props = defineProps<Props>();

const signals = useMockSignals();

// Channel-coded colors — L (ch 0) = cool blue, R (ch 1) = warm orange.
// Matches Adobe Audition / Pro Tools convention. Channels beyond stereo
// fall back to a muted neutral so additional channels read as "other".
const CHANNEL_COLORS: ReadonlyArray<string> = ["#5fa8ff", "#ff8b66"];
const channelColor = computed(() => CHANNEL_COLORS[props.channelIndex] ?? "var(--u-text-muted)");

const waveformCanvasRef = ref<HTMLCanvasElement | null>(null);
const spectrogramCanvasRef = ref<HTMLCanvasElement | null>(null);

// Time-axis (X) zoom for the waveform. Controls how many ring-buffer samples
// are mapped into the canvas width — small windows show transient detail
// (~5 ms), large windows show envelope shape (= up to the 10 s ring capacity).
// Slider is log-scaled because the useful range spans ~3 orders of magnitude
// (256 samples → 480 000 samples) and linear would feel awful at the bottom.
const MIN_WINDOW_SAMPLES = 256;
const MAX_WINDOW_SAMPLES = signals.ringTotalSamples;
const LOG_MIN = Math.log(MIN_WINDOW_SAMPLES);
const LOG_MAX = Math.log(MAX_WINDOW_SAMPLES);

// 0..1000 (int step for finer slider precision than 0..100).
// 300 ≈ ~50 ms window, a comfortable starting point for music-rate signals.
const zoomPos = ref(300);
const ZOOM_POS_MAX = 1000;

const timeWindowSamples = computed(() =>
  Math.round(Math.exp(LOG_MIN + ((LOG_MAX - LOG_MIN) * zoomPos.value) / ZOOM_POS_MAX)),
);
const timeWindowMs = computed(() => (timeWindowSamples.value / signals.sampleRate) * 1000);

const formatTimeWindow = (ms: number): string => {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(1)} ms`;
};

// Reusable sample-read buffer — sized at mount to the maximum the slider can
// request, then sub-arrayed per draw. Avoids GC pressure that would otherwise
// hit ~80 MB/s at the longest zoom (10 s × 60 fps × 3 ports).
const sampleBuf = new Float32Array(MAX_WINDOW_SAMPLES);

const drawWaveform = (canvas: HTMLCanvasElement): void => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 120;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
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

  const n = signals.readRecentSamplesInto(
    props.port,
    props.channelIndex,
    timeWindowSamples.value,
    sampleBuf,
  );
  if (n === 0) return;
  const samples = sampleBuf.subarray(0, n);

  const samplesPerPixel = n / w;
  const halfH = h / 2 - 4;
  const center = h / 2;

  ctx.strokeStyle = CHANNEL_COLORS[props.channelIndex] ?? "#a0a0a0";
  ctx.beginPath();

  if (samplesPerPixel <= 1) {
    // Zoomed in: 1 or fewer samples per pixel — polyline through every
    // sample is the only sensible rendering when data is sparser than the
    // canvas. Every sample reached exactly, no visual interpolation.
    ctx.lineWidth = 1.4;
    const xDen = Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / xDen) * w;
      const v = samples[i]!;
      const y = center - Math.max(-1, Math.min(1, v)) * halfH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    // Zoomed out: per-pixel min/max bar. Standard live-scope rendering —
    // each pixel column is one vertical stroke from min(samples in bucket)
    // to max(samples in bucket). Honest about what we're showing (= the
    // actual peaks within this slice of time) with no curve fitting or
    // polygon fill that would visually invent shape between sample points.
    ctx.lineWidth = 1;
    for (let px = 0; px < w; px++) {
      const start = Math.floor(px * samplesPerPixel);
      const end = Math.min(n, Math.floor((px + 1) * samplesPerPixel));
      let min = 1;
      let max = -1;
      for (let s = start; s < end; s++) {
        const v = samples[s]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      // canvas Y is flipped: max sample → top of canvas, min → bottom
      const yTop = center - Math.max(-1, Math.min(1, max)) * halfH;
      const yBottom = center - Math.max(-1, Math.min(1, min)) * halfH;
      // +0.5 centers the 1-px stroke on the integer pixel column.
      ctx.moveTo(px + 0.5, yTop);
      ctx.lineTo(px + 0.5, yBottom);
    }
  }
  ctx.stroke();
};

const drawSpectrogram = (canvas: HTMLCanvasElement): void => {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || 120;
  // Round target dimensions to integers — non-integer dpr (e.g. 1.25 from OS
  // zoom) made `canvas.width !== w * dpr` fire every frame, which re-allocates
  // and clears the canvas, killing the rolling spectrogram history.
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const stripPx = Math.max(2, Math.round(2 * dpr));
  const existing = ctx.getImageData(stripPx, 0, canvas.width - stripPx, canvas.height);
  ctx.putImageData(existing, 0, 0);
  ctx.clearRect(canvas.width - stripPx, 0, stripPx, canvas.height);

  const frame = signals.getFreqDomainFrame(props.port, props.channelIndex);
  const bins = frame.length;
  const lutMax = VIRIDIS_LUT_256.length - 1;
  for (let i = 0; i < bins; i++) {
    const v = Math.max(0, Math.min(1, frame[bins - 1 - i]!));
    const y = (i / bins) * canvas.height;
    const cellH = canvas.height / bins + 1;
    ctx.fillStyle = VIRIDIS_LUT_256[Math.round(v * lutMax)]!;
    ctx.fillRect(canvas.width - stripPx, y, stripPx, cellH);
  }
};

let rafId: number | null = null;
const loop = (): void => {
  if (waveformCanvasRef.value) drawWaveform(waveformCanvasRef.value);
  if (spectrogramCanvasRef.value) drawSpectrogram(spectrogramCanvasRef.value);
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
    <header class="channel-head">
      <span class="channel-dot" :style="{ background: channelColor }"></span>
      <span class="channel-label mono">ch {{ channelIndex }}</span>
    </header>
    <div class="channel-canvases">
      <div class="canvas-block">
        <header class="canvas-head">
          <span class="canvas-title">Waveform</span>
          <span class="canvas-meta mono">time domain</span>
        </header>
        <div
          class="waveform-zoom"
          title="Drag to change time window (log-scaled from 5 ms to 10 s)"
        >
          <span class="zoom-axis-label mono">time</span>
          <RangeSlider v-model="zoomPos" :min="0" :max="ZOOM_POS_MAX" />
          <span class="zoom-value mono">{{ formatTimeWindow(timeWindowMs) }}</span>
        </div>
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
  gap: 8px;
}

.channel-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.channel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.channel-label {
  font-size: 11px;
  color: var(--u-text-muted);
  letter-spacing: 0.04em;
}

.channel-canvases {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Side-by-side waveform + spectrogram once the parent port-section has room.
   `container-type: inline-size` is set on .port-section in SignalsView, so
   this container query references that ancestor. Threshold lowered to 500px
   (was 800px) — with the 280px audio-grid min, a single port-section never
   reaches 800px at common viewports, so the old query was effectively dead. */
@container (min-width: 500px) {
  .channel-canvases {
    flex-direction: row;
  }
  .canvas-block {
    flex: 1;
    min-width: 0;
  }
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

/* Time-axis zoom slider above the waveform canvas. Compact row so it doesn't
   eat much vertical space; the value readout to the right shows the current
   window in human-friendly units (ms / s). */
.waveform-zoom {
  display: grid;
  grid-template-columns: auto minmax(80px, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.zoom-axis-label {
  font-size: 9.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--u-text-dim);
}

.zoom-value {
  min-width: 48px;
  text-align: right;
  font-size: 10.5px;
  color: var(--u-text-muted);
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
