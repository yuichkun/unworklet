<script setup lang="ts">
import { ref } from "vue";
import { useProcessor } from "../audio/useProcessor";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import SpectrumAnalyzer from "../components/SpectrumAnalyzer.vue";
import Oscilloscope from "../components/Oscilloscope.vue";

const { node } = useProcessor({ processorName: "threeBandEQ" });
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
    title="Three-Band Biquad EQ"
    subtitle="Example 02"
    description="Cascaded peaking filters as defineSubgraph instances. Each band owns its own state pair (z1/z2). Adjust freq/Q/gain for each band."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
    </div>
    <div class="row">
      <div class="panel col">
        <h3>Low band</h3>
        <div class="row">
          <ParamControl :param="node?.params.lowFreq" label="Freq" :min="20" :max="1000" exp unit="Hz" />
          <ParamControl :param="node?.params.lowQ" label="Q" :min="0.1" :max="8" />
          <ParamControl :param="node?.params.lowGain" label="Gain" :min="-24" :max="24" unit="dB" />
        </div>
      </div>
      <div class="panel col">
        <h3>Mid band</h3>
        <div class="row">
          <ParamControl :param="node?.params.midFreq" label="Freq" :min="200" :max="8000" exp unit="Hz" />
          <ParamControl :param="node?.params.midQ" label="Q" :min="0.1" :max="8" />
          <ParamControl :param="node?.params.midGain" label="Gain" :min="-24" :max="24" unit="dB" />
        </div>
      </div>
      <div class="panel col">
        <h3>High band</h3>
        <div class="row">
          <ParamControl :param="node?.params.hiFreq" label="Freq" :min="1000" :max="20000" exp unit="Hz" />
          <ParamControl :param="node?.params.hiQ" label="Q" :min="0.1" :max="8" />
          <ParamControl :param="node?.params.hiGain" label="Gain" :min="-24" :max="24" unit="dB" />
        </div>
      </div>
    </div>
    <div class="row">
      <SpectrumAnalyzer :source="node?.node ?? null" label="Output spectrum (log)" />
      <Oscilloscope :source="node?.node ?? null" label="Output waveform" />
    </div>
  </ShowcaseShell>
</template>
