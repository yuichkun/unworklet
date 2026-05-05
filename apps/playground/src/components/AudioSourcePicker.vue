<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import {
  audioContext,
  ensureRunning,
  getMicrophone,
  loadAudioFile,
} from "../audio/AudioEngine";

const emit = defineEmits<{ source: [node: AudioNode | null]; sourceLabel: [s: string] }>();

type SourceType = "none" | "mic" | "loop" | "osc" | "noise";
const type = ref<SourceType>("none");
const oscFreq = ref(440);
const oscType = ref<OscillatorType>("sine");
const fileBuffer = ref<AudioBuffer | null>(null);
const fileName = ref("");
const playing = ref(false);

let currentSource: AudioNode | null = null;
let currentBufferSrc: AudioBufferSourceNode | null = null;
let currentOsc: OscillatorNode | null = null;
let currentNoise: AudioWorkletNode | ScriptProcessorNode | null = null;

function disconnectAll() {
  if (currentSource) {
    try {
      currentSource.disconnect();
    } catch {}
  }
  currentSource = null;
  currentBufferSrc?.stop();
  currentBufferSrc = null;
  currentOsc?.stop();
  currentOsc = null;
  if (currentNoise) {
    try {
      (currentNoise as any).disconnect();
    } catch {}
  }
  currentNoise = null;
  playing.value = false;
}

async function start() {
  await ensureRunning();
  disconnectAll();
  const ctx = audioContext();
  if (type.value === "mic") {
    const node = await getMicrophone();
    currentSource = node;
    emit("source", node);
    emit("sourceLabel", "microphone");
  } else if (type.value === "loop" && fileBuffer.value) {
    const src = ctx.createBufferSource();
    src.buffer = fileBuffer.value;
    src.loop = true;
    src.start();
    currentBufferSrc = src;
    currentSource = src;
    emit("source", src);
    emit("sourceLabel", `file: ${fileName.value}`);
  } else if (type.value === "osc") {
    const osc = ctx.createOscillator();
    osc.type = oscType.value;
    osc.frequency.value = oscFreq.value;
    osc.start();
    currentOsc = osc;
    currentSource = osc;
    emit("source", osc);
    emit("sourceLabel", `osc ${oscType.value} ${oscFreq.value}Hz`);
  } else if (type.value === "noise") {
    // White noise via ScriptProcessorNode (one-shot, replaceable later with worklet)
    const sp = ctx.createScriptProcessor(2048, 0, 2);
    sp.onaudioprocess = (e) => {
      const l = e.outputBuffer.getChannelData(0);
      const r = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < l.length; i++) {
        const v = Math.random() * 2 - 1;
        l[i] = v * 0.5;
        r[i] = v * 0.5;
      }
    };
    // ScriptProcessor requires connection to destination to run; we connect to a muted gain
    const muted = ctx.createGain();
    muted.gain.value = 0;
    sp.connect(muted).connect(ctx.destination);
    currentNoise = sp;
    currentSource = sp;
    emit("source", sp);
    emit("sourceLabel", "white noise");
  } else {
    emit("source", null);
    emit("sourceLabel", "none");
  }
  playing.value = type.value !== "none";
}

function stop() {
  disconnectAll();
  emit("source", null);
  emit("sourceLabel", "none");
  type.value = "none";
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  fileBuffer.value = await loadAudioFile(file);
}

watch([oscFreq, oscType], () => {
  if (currentOsc) {
    currentOsc.frequency.value = oscFreq.value;
    currentOsc.type = oscType.value;
  }
});

onBeforeUnmount(() => disconnectAll());
</script>

<template>
  <div class="picker panel">
    <h3>Audio source</h3>
    <div class="row">
      <select v-model="type">
        <option value="none">— none —</option>
        <option value="mic">Microphone</option>
        <option value="loop">File loop</option>
        <option value="osc">Test oscillator</option>
        <option value="noise">White noise</option>
      </select>
      <button class="primary" @click="start" :disabled="type === 'none' || (type === 'loop' && !fileBuffer)">
        ▶ Start
      </button>
      <button @click="stop" :disabled="!playing">■ Stop</button>
    </div>
    <div class="row" v-if="type === 'loop'">
      <input type="file" accept="audio/*" @change="onFile" />
      <span class="muted" v-if="fileName">{{ fileName }}</span>
    </div>
    <div class="row" v-if="type === 'osc'">
      <select v-model="oscType">
        <option value="sine">sine</option>
        <option value="triangle">triangle</option>
        <option value="sawtooth">saw</option>
        <option value="square">square</option>
      </select>
      <label class="muted">freq</label>
      <input type="number" v-model.number="oscFreq" min="20" max="20000" step="1" style="width: 90px" />
      <span class="muted">Hz</span>
    </div>
  </div>
</template>

<style scoped>
.picker {
  flex: 1;
  min-width: 320px;
}
</style>
