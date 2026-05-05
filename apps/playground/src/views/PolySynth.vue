<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useProcessor } from "../audio/useProcessor";
import { audioContext, ensureRunning } from "../audio/AudioEngine";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import ParamControl from "../components/ParamControl.vue";
import MidiKeyboard from "../components/MidiKeyboard.vue";
import MidiInputPicker from "../components/MidiInputPicker.vue";
import StatePill from "../components/StatePill.vue";
import Oscilloscope from "../components/Oscilloscope.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import type { MidiEvent } from "@unworklet/core";

const { node } = useProcessor({ processorName: "polySynth" });

function onKbdNoteOn(note: number, velocity: number) {
  node.value?.midi.send({ type: "noteOn", channel: 0, note, velocity, atSample: 0 } as MidiEvent);
}
function onKbdNoteOff(note: number) {
  node.value?.midi.send({ type: "noteOff", channel: 0, note, velocity: 0, atSample: 0 } as MidiEvent);
}
function onMidiInput(input: any) {
  if (input && node.value) node.value.midi.connectFromWebMIDI(input);
}

const sidechain = ref<AudioNode | null>(null);
function onSidechainSource(s: AudioNode | null) {
  sidechain.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0); // sidechain is port 0
    } catch {}
  }
}

const flashes = ref<Set<number>>(new Set());
let unsubE: (() => void) | null = null;
watchEffect(() => {
  unsubE?.();
  if (node.value) {
    unsubE = node.value.events.notePlayed!.on((p: any) => {
      flashes.value.add(p.note);
      setTimeout(() => flashes.value.delete(p.note), 250);
    });
  }
});
onBeforeUnmount(() => unsubE?.());
</script>

<template>
  <ShowcaseShell
    title="Polyphonic Synth + Sidechain Ducking"
    subtitle="Example 08"
    description="8-voice synth with per-voice subgraph (oscillator + envelope), sidechain duck envelope from a separate input, sample-accurate notePlayed events."
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
        <h3>Envelope</h3>
        <div class="row">
          <ParamControl :param="node?.params.attack" label="Attack" :min="0.001" :max="1" exp unit="s" />
          <ParamControl :param="node?.params.release" label="Release" :min="0.01" :max="4" exp unit="s" />
        </div>
      </div>
      <div class="panel col">
        <h3>Mix</h3>
        <div class="row">
          <ParamControl :param="node?.params.masterVol" label="Volume" :min="0" :max="1" :default="0.7" />
          <ParamControl :param="node?.params.duckAmount" label="Duck" :min="0" :max="1" :default="0.5" />
        </div>
      </div>
    </div>
    <div class="row">
      <AudioSourcePicker @source="onSidechainSource" />
      <p class="muted small">
        Pick a source above (e.g. white noise / file loop) to drive the sidechain duck input.
      </p>
    </div>
    <div class="panel">
      <h3>Keyboard</h3>
      <MidiKeyboard @noteOn="onKbdNoteOn" @noteOff="onKbdNoteOff" />
    </div>
    <Oscilloscope :source="node?.node ?? null" label="Output" />
  </ShowcaseShell>
</template>

<style scoped>
.small { font-size: 13px; }
</style>
