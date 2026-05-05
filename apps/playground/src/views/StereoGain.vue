<script setup lang="ts">
import { computed, ref } from "vue";
import { useProcessor } from "../audio/useProcessor";
import { audioContext } from "../audio/AudioEngine";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import StatePill from "../components/StatePill.vue";
import Oscilloscope from "../components/Oscilloscope.vue";
import LevelMeter from "../components/LevelMeter.vue";

const { node, ready } = useProcessor({ processorName: "stereoGain" });
const source = ref<AudioNode | null>(null);
function onSource(s: AudioNode | null) {
  // Disconnect previous
  source.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0);
    } catch {}
  }
}

// Reactive meter values from state.publish
const meterL = ref(0);
const meterR = ref(0);
let unsubL: (() => void) | null = null;
let unsubR: (() => void) | null = null;
import { watchEffect, onBeforeUnmount } from "vue";
watchEffect(() => {
  unsubL?.();
  unsubR?.();
  if (node.value) {
    unsubL = node.value.state.meterL!.subscribe((v: number) => (meterL.value = v));
    unsubR = node.value.state.meterR!.subscribe((v: number) => (meterR.value = v));
  }
});
onBeforeUnmount(() => {
  unsubL?.();
  unsubR?.();
});
</script>

<template>
  <ShowcaseShell
    title="Stereo Gain + Level Meter"
    subtitle="Example 01"
    description="Minimum-useful unworklet plugin: a-rate gain param, two state.publish slots driving a UI VU meter at 30 fps."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
      <div class="panel controls col">
        <h3>Parameters</h3>
        <div class="row">
          <ParamControl :param="node?.params.gain" label="Gain" :min="0" :max="4" :default="1" />
        </div>
      </div>
      <div class="panel col">
        <h3>Output meter</h3>
        <LevelMeter :value="meterL" :max="1.5" label="L" />
        <LevelMeter :value="meterR" :max="1.5" label="R" />
        <StatePill :node="node" slot="meterL" label="meterL" />
        <StatePill :node="node" slot="meterR" label="meterR" />
      </div>
    </div>
    <div class="row">
      <Oscilloscope :source="node?.node ?? null" label="Output waveform" />
    </div>
  </ShowcaseShell>
</template>

<style scoped>
.controls {
  flex: 0 0 auto;
}
</style>
