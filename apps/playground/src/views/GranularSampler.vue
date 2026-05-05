<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from "vue";
import { useProcessor } from "../audio/useProcessor";
import { audioContext, getMidiAccess, loadAudioFile } from "../audio/AudioEngine";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import ParamControl from "../components/ParamControl.vue";
import MidiKeyboard from "../components/MidiKeyboard.vue";
import MidiInputPicker from "../components/MidiInputPicker.vue";
import Oscilloscope from "../components/Oscilloscope.vue";
import StatePill from "../components/StatePill.vue";
import type { MidiEvent } from "@unworklet/core";

const { node } = useProcessor({ processorName: "granularSampler" });

const fileName = ref("");
async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !node.value) return;
  fileName.value = file.name;
  const buf = await loadAudioFile(file);
  const samples = buf.getChannelData(0);
  node.value.messages.uploadSample!({ samples });
}

function onKbdNoteOn(note: number, velocity: number) {
  node.value?.midi.send({ type: "noteOn", channel: 0, note, velocity, atSample: 0 } as MidiEvent);
}
function onKbdNoteOff(note: number) {
  node.value?.midi.send({ type: "noteOff", channel: 0, note, velocity: 0, atSample: 0 } as MidiEvent);
}
function onMidiInput(input: any) {
  if (input && node.value) node.value.midi.connectFromWebMIDI(input);
}

const playingCount = ref(0);
let unsub: (() => void) | null = null;
watchEffect(() => {
  unsub?.();
  if (node.value) {
    unsub = node.value.state.playingCount!.subscribe((v: number) => (playingCount.value = v));
  }
});
onBeforeUnmount(() => unsub?.());
</script>

<template>
  <ShowcaseShell
    title="Granular Sampler"
    subtitle="Example 05"
    description="16-voice granular synth with bulk message<T> sample upload, MIDI note triggers and buffer.publish waveform thumbnail at 15 fps."
  >
    <div class="row">
      <div class="panel col">
        <h3>Sample upload</h3>
        <input type="file" accept="audio/*" @change="onFile" />
        <div class="muted small" v-if="fileName">Loaded: {{ fileName }}</div>
        <div class="muted small" v-else>Pick a short audio file (a vocal loop or pad works well).</div>
      </div>
      <div class="panel col">
        <h3>Voices</h3>
        <StatePill :node="node" slot="playingCount" label="active voices" />
        <div class="muted small">{{ playingCount }} / 16</div>
      </div>
    </div>
    <div class="row">
      <div class="panel col">
        <h3>Grain controls</h3>
        <div class="row">
          <ParamControl :param="node?.params.grainSizeMs" label="Size" :min="10" :max="500" exp unit="ms" />
          <ParamControl :param="node?.params.grainHz" label="Density" :min="1" :max="100" exp unit="Hz" />
          <ParamControl :param="node?.params.playbackPos" label="Pos" :min="0" :max="1" />
          <ParamControl :param="node?.params.pitch" label="Pitch" :min="0.25" :max="4" exp />
        </div>
      </div>
    </div>
    <div class="row">
      <MidiInputPicker @midiInput="onMidiInput" />
    </div>
    <div class="panel">
      <h3>On-screen keyboard</h3>
      <MidiKeyboard @noteOn="onKbdNoteOn" @noteOff="onKbdNoteOff" />
    </div>
    <Oscilloscope :source="node?.node ?? null" label="Output" />
  </ShowcaseShell>
</template>
