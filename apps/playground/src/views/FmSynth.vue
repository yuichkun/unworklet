<script setup lang="ts">
import { ref, watchEffect, onBeforeUnmount } from "vue";
import { useProcessor } from "../audio/useProcessor";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import ParamControl from "../components/ParamControl.vue";
import MidiKeyboard from "../components/MidiKeyboard.vue";
import MidiInputPicker from "../components/MidiInputPicker.vue";
import StatePill from "../components/StatePill.vue";
import Oscilloscope from "../components/Oscilloscope.vue";
import SpectrumAnalyzer from "../components/SpectrumAnalyzer.vue";
import type { MidiEvent } from "@unworklet/core";

const { node } = useProcessor({ processorName: "fmSynth" });

function onKbdNoteOn(note: number, velocity: number) {
  node.value?.midi.send({ type: "noteOn", channel: 0, note, velocity, atSample: 0 } as MidiEvent);
}
function onKbdNoteOff(note: number) {
  node.value?.midi.send({ type: "noteOff", channel: 0, note, velocity: 0, atSample: 0 } as MidiEvent);
}
function onMidiInput(input: any) {
  if (input && node.value) node.value.midi.connectFromWebMIDI(input);
}
</script>

<template>
  <ShowcaseShell
    title="FM Synth"
    subtitle="Showcase 14"
    description="Six-voice 2-operator FM synthesizer. Modulator-to-carrier ratio + index for harmonic content shaping."
  >
    <div class="row">
      <MidiInputPicker @midiInput="onMidiInput" />
      <div class="panel col">
        <h3>Voices</h3>
        <StatePill :node="node" slot="activeVoices" label="Active" />
      </div>
    </div>
    <div class="row">
      <div class="panel col">
        <h3>FM</h3>
        <div class="row">
          <ParamControl :param="node?.params.modRatio" label="Ratio" :min="0.25" :max="16" exp :default="2" />
          <ParamControl :param="node?.params.modIndex" label="Index" :min="0" :max="12" :default="1.5" />
        </div>
      </div>
      <div class="panel col">
        <h3>Envelope</h3>
        <div class="row">
          <ParamControl :param="node?.params.attack" label="Attack" :min="0.001" :max="1" exp :default="0.005" unit="s" />
          <ParamControl :param="node?.params.release" label="Release" :min="0.01" :max="4" exp :default="0.4" unit="s" />
          <ParamControl :param="node?.params.masterVol" label="Vol" :min="0" :max="1" :default="0.7" />
        </div>
      </div>
    </div>
    <div class="panel">
      <h3>Keyboard</h3>
      <MidiKeyboard @noteOn="onKbdNoteOn" @noteOff="onKbdNoteOff" />
    </div>
    <div class="row">
      <Oscilloscope :source="node?.node ?? null" label="Waveform" />
      <SpectrumAnalyzer :source="node?.node ?? null" label="Spectrum" />
    </div>
  </ShowcaseShell>
</template>
