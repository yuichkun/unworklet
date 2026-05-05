<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from "vue";
import { useProcessor } from "../audio/useProcessor";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import Oscilloscope from "../components/Oscilloscope.vue";
import LevelMeter from "../components/LevelMeter.vue";

const { node } = useProcessor({ processorName: "distortion" });
const source = ref<AudioNode | null>(null);
function onSource(s: AudioNode | null) {
  source.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0);
    } catch {}
  }
}

const peak = ref(0);
let unsub: (() => void) | null = null;
watchEffect(() => {
  unsub?.();
  if (node.value) unsub = node.value.state.peak!.subscribe((v: number) => (peak.value = v));
});
onBeforeUnmount(() => unsub?.());
</script>

<template>
  <ShowcaseShell
    title="Distortion (tanh saturator)"
    subtitle="Showcase 11"
    description="Soft-clipping waveshaper with tilt-EQ tone control and output gain. Push the drive for crunch."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
      <div class="panel col">
        <h3>Tone</h3>
        <div class="row">
          <ParamControl :param="node?.params.drive" label="Drive" :min="1" :max="30" exp :default="4" />
          <ParamControl :param="node?.params.tone" label="Tone" :min="0" :max="1" :default="0.5" />
          <ParamControl :param="node?.params.outGain" label="Out" :min="0" :max="2" :default="0.4" />
        </div>
      </div>
      <div class="panel col">
        <h3>Output</h3>
        <LevelMeter :value="peak" :max="2" label="peak" />
      </div>
    </div>
    <Oscilloscope :source="node?.node ?? null" label="Output (watch the corners flatten)" />
  </ShowcaseShell>
</template>
