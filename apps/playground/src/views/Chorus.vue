<script setup lang="ts">
import { ref } from "vue";
import { useProcessor } from "../audio/useProcessor";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import Oscilloscope from "../components/Oscilloscope.vue";

const { node } = useProcessor({ processorName: "chorus" });
const source = ref<AudioNode | null>(null);
function onSource(s: AudioNode | null) {
  source.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0);
    } catch {}
  }
}
</script>

<template>
  <ShowcaseShell
    title="Stereo Chorus"
    subtitle="Showcase 10"
    description="Two LFO-modulated delay lines cross-staggered between the channels — adds width and richness without obvious echoes."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
      <div class="panel col">
        <h3>Modulation</h3>
        <div class="row">
          <ParamControl :param="node?.params.rateHz" label="Rate" :min="0.05" :max="8" exp :default="0.7" unit="Hz" />
          <ParamControl :param="node?.params.depthMs" label="Depth" :min="0" :max="20" :default="4" unit="ms" />
          <ParamControl :param="node?.params.baseMs" label="Base" :min="1" :max="40" :default="12" unit="ms" />
          <ParamControl :param="node?.params.mix" label="Mix" :min="0" :max="1" :default="0.5" />
        </div>
      </div>
    </div>
    <Oscilloscope :source="node?.node ?? null" label="Output" />
  </ShowcaseShell>
</template>
