<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useProcessor } from "../audio/useProcessor";
import { audioContext, ensureRunning } from "../audio/AudioEngine";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import MidiKeyboard from "../components/MidiKeyboard.vue";
import MidiInputPicker from "../components/MidiInputPicker.vue";
import StatePill from "../components/StatePill.vue";
import type { MidiEvent } from "@unworklet/core";

const { node } = useProcessor({ processorName: "arpeggiator" });
let downstreamSynthNode: AudioWorkletNode | null = null;

import { createBrowserNode } from "../audio/createBrowserNode";

// Spawn a downstream synth (the polySynth) so the arpeggiator's MIDI output drives audio.
const downstream = ref<any | null>(null);
onMounted(async () => {
  await ensureRunning();
  const ctx = audioContext();
  const synth = await createBrowserNode(ctx, "polySynth");
  // Connect to destination
  synth.outputs.main!.connect(ctx.destination);
  downstream.value = synth;
});
onBeforeUnmount(() => downstream.value?.dispose());

const lastSteps = ref<Array<{ at: number; note: number; step: number }>>([]);
const stepCursor = ref(0);

watchEffect(() => {
  if (node.value && downstream.value) {
    node.value.midi.onEvent("noteOn", (e: any) => {
      // Forward to downstream synth
      downstream.value.midi.send(e);
      // Also schedule a noteOff a beat later (simple visual; the canonical
      // arp doesn't manage note-off lengths)
      setTimeout(() => {
        downstream.value.midi.send({ ...e, type: "noteOff", velocity: 0 });
      }, 220);
    });
    node.value.events.stepFired!.on((p: any) => {
      lastSteps.value.push(p);
      if (lastSteps.value.length > 32) lastSteps.value.shift();
    });
    node.value.state.stepIdx!.subscribe((s: number) => (stepCursor.value = s));
  }
});

function onKbdNoteOn(note: number, velocity: number) {
  node.value?.midi.send({ type: "noteOn", channel: 0, note, velocity, atSample: 0 } as MidiEvent);
}
function onKbdNoteOff(note: number) {
  node.value?.midi.send({ type: "noteOff", channel: 0, note, velocity: 0, atSample: 0 } as MidiEvent);
}
function onMidiInput(input: any) {
  if (input && node.value) node.value.midi.connectFromWebMIDI(input);
}

// Pattern editor
const PATTERN_LEN = 16;
const pattern = ref<number[]>([0, 4, 7, 12, 7, 4, 0, -3, 0, 4, 7, 12, 7, 4, 0, -3]);
function uploadPattern() {
  if (!node.value) return;
  node.value.messages.loadPattern!({ steps: new Int32Array(pattern.value) });
}
onMounted(() => setTimeout(uploadPattern, 200));
</script>

<template>
  <ShowcaseShell
    title="MIDI Arpeggiator + Sequencer"
    subtitle="Example 06"
    description="Pure MIDI processor: midiInput → midiOutput. Hold a note on your keyboard; the arp generates 1/8-note runs through a 16-step pattern. Output is routed into the polySynth showcase to make sound."
  >
    <div class="row">
      <MidiInputPicker @midiInput="onMidiInput" />
      <div class="panel col">
        <h3>Live step</h3>
        <StatePill :node="node" slot="stepIdx" label="Active step" />
        <div class="cursor-row">
          <div
            v-for="i in PATTERN_LEN"
            :key="i"
            class="cell"
            :class="{ active: stepCursor === i - 1 }"
          >
            {{ i }}
          </div>
        </div>
      </div>
    </div>
    <div class="panel col">
      <h3>16-step pattern (semitone offsets from root)</h3>
      <div class="pattern">
        <input v-for="(_, i) in pattern" :key="i" type="number" v-model.number="pattern[i]" :min="-24" :max="24" />
      </div>
      <button class="primary" @click="uploadPattern">Upload pattern</button>
    </div>
    <div class="panel">
      <h3>On-screen keyboard</h3>
      <MidiKeyboard @noteOn="onKbdNoteOn" @noteOff="onKbdNoteOff" />
    </div>
  </ShowcaseShell>
</template>

<style scoped>
.cursor-row {
  display: flex;
  gap: 4px;
}
.cell {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.cell.active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.pattern {
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  gap: 4px;
}
.pattern input {
  width: 100%;
  text-align: center;
}
</style>
