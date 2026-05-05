<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from "vue";
import { useProcessor } from "../audio/useProcessor";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import LevelMeter from "../components/LevelMeter.vue";
import Oscilloscope from "../components/Oscilloscope.vue";

const { node } = useProcessor({ processorName: "compressor" });
const source = ref<AudioNode | null>(null);
function onSource(s: AudioNode | null) {
  source.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0);
    } catch {}
  }
}

const grDb = ref(0);
let unsub: (() => void) | null = null;
watchEffect(() => {
  unsub?.();
  if (node.value) unsub = node.value.state.gainReductionDb!.subscribe((v: number) => (grDb.value = v));
});
onBeforeUnmount(() => unsub?.());
</script>

<template>
  <ShowcaseShell
    title="Compressor"
    subtitle="Showcase 13"
    description="Soft-knee feed-forward compressor. Threshold, ratio, attack/release, knee width, makeup gain."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
      <div class="panel col">
        <h3>Dynamics</h3>
        <div class="row">
          <ParamControl :param="node?.params.threshold" label="Thresh" :min="-60" :max="0" :default="-18" unit="dB" />
          <ParamControl :param="node?.params.ratio" label="Ratio" :min="1" :max="20" exp :default="4" />
          <ParamControl :param="node?.params.kneeDb" label="Knee" :min="0" :max="24" :default="6" unit="dB" />
        </div>
      </div>
      <div class="panel col">
        <h3>Time</h3>
        <div class="row">
          <ParamControl :param="node?.params.attackMs" label="Attack" :min="0.1" :max="200" exp :default="5" unit="ms" />
          <ParamControl :param="node?.params.releaseMs" label="Release" :min="1" :max="1000" exp :default="80" unit="ms" />
          <ParamControl :param="node?.params.makeupDb" label="Makeup" :min="0" :max="24" :default="0" unit="dB" />
        </div>
      </div>
      <div class="panel col">
        <h3>Gain reduction</h3>
        <LevelMeter :value="-grDb" :max="24" label="GR (dB)" />
      </div>
    </div>
    <Oscilloscope :source="node?.node ?? null" label="Output" />
  </ShowcaseShell>
</template>
