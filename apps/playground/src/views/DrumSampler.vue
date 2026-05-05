<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useProcessor } from "../audio/useProcessor";
import { audioContext, loadAudioFile } from "../audio/AudioEngine";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import ParamControl from "../components/ParamControl.vue";
import Oscilloscope from "../components/Oscilloscope.vue";
import MidiInputPicker from "../components/MidiInputPicker.vue";
import type { MidiEvent } from "@unworklet/core";

const { node } = useProcessor({ processorName: "drumSampler" });

const NUM_PADS = 8;
const padNames = ["KICK", "SNARE", "CL HAT", "OP HAT", "TOM 1", "TOM 2", "CLAP", "CRASH"];
const padFiles = ref<Array<string | null>>(new Array(NUM_PADS).fill(null));
const flashing = ref<Set<number>>(new Set());

async function onFile(pad: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !node.value) return;
  padFiles.value[pad] = file.name;
  const buf = await loadAudioFile(file);
  const samples = buf.getChannelData(0);
  node.value.messages.uploadPad!({ pad, samples });
}

function trigger(pad: number) {
  if (!node.value) return;
  flashing.value.add(pad);
  setTimeout(() => flashing.value.delete(pad), 100);
  node.value.messages.triggerPad!({ pad, velocity: 1.0 });
}

function loadDefaultKit() {
  if (!node.value) return;
  const ctx = audioContext();
  const sr = ctx.sampleRate;
  // Synthesize quick percussion sounds for each pad
  const synth = (durationSec: number, render: (t: number, i: number, len: number) => number) => {
    const len = Math.ceil(durationSec * sr);
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) buf[i] = render(i / sr, i, len);
    return buf;
  };
  const kick = synth(0.4, (t, i, len) => {
    const env = Math.exp(-t * 8);
    const f = 60 * Math.exp(-t * 12) + 30;
    return Math.sin(2 * Math.PI * f * t) * env * 0.9;
  });
  const snare = synth(0.25, (t, i, len) => {
    const noise = (Math.random() * 2 - 1) * Math.exp(-t * 18);
    const tone = Math.sin(2 * Math.PI * 200 * t) * Math.exp(-t * 35);
    return (noise * 0.7 + tone * 0.4) * 0.85;
  });
  const clHat = synth(0.07, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 90) * 0.5);
  const opHat = synth(0.4, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 6) * 0.4);
  const tom1 = synth(0.4, (t) => Math.sin(2 * Math.PI * (110 * Math.exp(-t * 6) + 80) * t) * Math.exp(-t * 6) * 0.7);
  const tom2 = synth(0.4, (t) => Math.sin(2 * Math.PI * (180 * Math.exp(-t * 8) + 100) * t) * Math.exp(-t * 8) * 0.7);
  const clap = synth(0.15, (t) => (Math.random() * 2 - 1) * Math.exp(-((t - 0.02) ** 2) * 1500) * 0.7);
  const crash = synth(0.8, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 2.5) * 0.55);

  const pads = [kick, snare, clHat, opHat, tom1, tom2, clap, crash];
  pads.forEach((samples, i) => {
    node.value!.messages.uploadPad!({ pad: i, samples });
    padFiles.value[i] = `synth: ${padNames[i]}`;
  });
}

function onMidiInput(input: any) {
  if (input && node.value) node.value.midi.connectFromWebMIDI(input);
}

onMounted(() => setTimeout(loadDefaultKit, 200));

// QWERTY drum pad mapping
const padKeys = ["1", "2", "3", "4", "5", "6", "7", "8"];
function onKey(e: KeyboardEvent) {
  const idx = padKeys.indexOf(e.key);
  if (idx >= 0) trigger(idx);
}
import { onBeforeUnmount } from "vue";
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <ShowcaseShell
    title="Drum Sampler"
    subtitle="Showcase 12"
    description="8-pad drum machine. Each pad has a buffer.f32 (4s @ 48k), uploaded via message<T>. Trigger with the on-screen pads, the keys 1-8, or your MIDI controller (notes 36-43)."
  >
    <div class="row">
      <MidiInputPicker @midiInput="onMidiInput" />
      <div class="panel col">
        <h3>Master</h3>
        <ParamControl :param="node?.params.masterVol" label="Volume" :min="0" :max="2" :default="0.8" />
        <button @click="loadDefaultKit">Reload synth kit</button>
      </div>
    </div>
    <div class="pads">
      <div
        v-for="(name, i) in padNames"
        :key="i"
        class="pad"
        :class="{ flashing: flashing.has(i) }"
        @pointerdown="trigger(i)"
      >
        <div class="pad-key">{{ padKeys[i] }}</div>
        <div class="pad-name">{{ name }}</div>
        <div class="pad-file muted">{{ padFiles[i] ?? "(empty)" }}</div>
        <input type="file" accept="audio/*" @change="onFile(i, $event)" @click.stop />
      </div>
    </div>
    <Oscilloscope :source="node?.node ?? null" label="Master output" />
  </ShowcaseShell>
</template>

<style scoped>
.pads {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.pad {
  background: var(--bg-2);
  border: 2px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  cursor: pointer;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: 80ms;
}
.pad:hover {
  border-color: var(--accent);
}
.pad.flashing {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.pad-key {
  display: inline-block;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 4px;
  text-align: center;
  font-size: 12px;
  font-family:
    "JetBrains Mono", "SF Mono", monospace;
  line-height: 22px;
}
.pad.flashing .pad-key {
  border-color: var(--bg);
}
.pad-name {
  font-weight: 600;
  font-size: 13px;
}
.pad-file {
  font-size: 10px;
}
input[type="file"] {
  font-size: 10px;
  width: 100%;
}
</style>
