<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useProcessor } from "../audio/useProcessor";
import { audioContext, loadAudioFile } from "../audio/AudioEngine";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import LevelMeter from "../components/LevelMeter.vue";
import Oscilloscope from "../components/Oscilloscope.vue";

const { node } = useProcessor({ processorName: "convolutionReverb" });
const fileName = ref("");
const wetMeter = ref(0);
const source = ref<AudioNode | null>(null);

function onSource(s: AudioNode | null) {
  source.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0);
    } catch {}
  }
}

async function onIRFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !node.value) return;
  fileName.value = file.name;
  const buf = await loadAudioFile(file);
  const irL = buf.getChannelData(0);
  const irR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : irL;
  node.value.messages.uploadIR!({ irL, irR });
}

function loadSyntheticIR() {
  if (!node.value) return;
  // Synthesize a quick exponential-decay impulse for demo when no IR file is provided.
  const len = 4096;
  const ir = new Float32Array(len);
  const sr = audioContext().sampleRate;
  ir[0] = 0.5;
  for (let i = 1; i < len; i++) {
    ir[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.4)) * 0.5;
  }
  node.value.messages.uploadIR!({ irL: ir, irR: ir.slice() });
  fileName.value = "synthetic decay";
}

let unsub: (() => void) | null = null;
watchEffect(() => {
  unsub?.();
  if (node.value) {
    unsub = node.value.state.wetMeter!.subscribe((v: number) => (wetMeter.value = v));
  }
});
onBeforeUnmount(() => unsub?.());

async function snapshotPreset() {
  if (!node.value) return;
  const blob = await node.value.snapshot();
  // Save to localStorage as base64
  const b64 = btoa(String.fromCharCode(...blob));
  localStorage.setItem("uw-reverb-preset", b64);
  alert(`Saved (${blob.byteLength} bytes)`);
}
async function restorePreset() {
  if (!node.value) return;
  const stored = localStorage.getItem("uw-reverb-preset");
  if (!stored) return alert("No saved preset");
  const blob = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const r = await node.value.restore(blob);
  alert(`Restored ${r.restored} slot(s); skipped ${r.skipped.length}; missing ${r.missing.length}`);
}
</script>

<template>
  <ShowcaseShell
    title="Convolution Reverb"
    subtitle="Example 07"
    description="Stereo partitioned-convolution reverb with IR upload, snapshot/restore + declarative migration chain. Drop in any IR .wav."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
      <div class="panel col">
        <h3>Impulse response</h3>
        <input type="file" accept="audio/*" @change="onIRFile" />
        <div class="muted small" v-if="fileName">Loaded: {{ fileName }}</div>
        <button @click="loadSyntheticIR">Load synthetic decay (demo)</button>
      </div>
      <div class="panel col">
        <h3>Mix</h3>
        <div class="row">
          <ParamControl :param="node?.params.wetGain" label="Wet" :min="0" :max="1" :default="0.5" />
          <ParamControl :param="node?.params.dryGain" label="Dry" :min="0" :max="1" :default="0.7" />
        </div>
        <LevelMeter :value="wetMeter" :max="1" label="wet meter" />
      </div>
    </div>
    <div class="row">
      <div class="panel col">
        <h3>Preset (snapshot/restore)</h3>
        <div class="row">
          <button @click="snapshotPreset">💾 Save</button>
          <button @click="restorePreset">↻ Restore</button>
        </div>
        <p class="muted small">
          Snapshot/restore is block-atomic on the worklet thread. Migration chain handles
          schema upgrades transparently — see the convolution-reverb source.
        </p>
      </div>
      <Oscilloscope :source="node?.node ?? null" label="Output" />
    </div>
  </ShowcaseShell>
</template>

<style scoped>
.small { font-size: 13px; line-height: 1.4; }
</style>
