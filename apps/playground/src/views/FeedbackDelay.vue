<script setup lang="ts">
import { ref } from "vue";
import { useProcessor } from "../audio/useProcessor";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import LevelMeter from "../components/LevelMeter.vue";
import Oscilloscope from "../components/Oscilloscope.vue";
import { onBeforeUnmount, watchEffect } from "vue";

const { node } = useProcessor({ processorName: "feedbackDelay" });
const source = ref<AudioNode | null>(null);
function onSource(s: AudioNode | null) {
  source.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0);
    } catch {}
  }
}

const meterL = ref(0);
const meterR = ref(0);
let unL: (() => void) | null = null;
let unR: (() => void) | null = null;
watchEffect(() => {
  unL?.();
  unR?.();
  if (node.value) {
    unL = node.value.state.meterL!.subscribe((v: number) => (meterL.value = v));
    unR = node.value.state.meterR!.subscribe((v: number) => (meterR.value = v));
  }
});
onBeforeUnmount(() => {
  unL?.();
  unR?.();
});
</script>

<template>
  <ShowcaseShell
    title="Feedback Delay (ping-pong)"
    subtitle="Showcase 09"
    description="Stereo delay line with cross-channel feedback. Wet/dry mix and feedback up to 0.95 — push it gently for ambient runaways."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
      <div class="panel col">
        <h3>Mix</h3>
        <div class="row">
          <ParamControl :param="node?.params.delayMs" label="Time" :min="1" :max="2000" exp unit="ms" :default="350" />
          <ParamControl :param="node?.params.feedback" label="Fbk" :min="0" :max="0.95" :default="0.45" />
          <ParamControl :param="node?.params.wet" label="Wet" :min="0" :max="1" :default="0.4" />
          <ParamControl :param="node?.params.dry" label="Dry" :min="0" :max="1" :default="0.7" />
          <ParamControl :param="node?.params.pingPong" label="Ping" :min="0" :max="1" :default="1" />
        </div>
      </div>
      <div class="panel col">
        <h3>Output</h3>
        <LevelMeter :value="meterL" label="L" />
        <LevelMeter :value="meterR" label="R" />
      </div>
    </div>
    <Oscilloscope :source="node?.node ?? null" label="Output waveform" />
  </ShowcaseShell>
</template>
