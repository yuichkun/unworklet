<script setup lang="ts">
import { computed, ref } from "vue";

import {
  type MidiEvent,
  type MidiPortMeta,
  portKey,
  useMockMidi,
} from "../composables/useMockMidi";

const midi = useMockMidi();

// keyboard = 2 octaves starting at C4 (= 25 keys)
const KEYBOARD_OCTAVE_BASE = 60; // C4 (= MIDI note 60)
const KEYBOARD_KEY_COUNT = 25;

type KeyDef = {
  midi: number;
  white: boolean;
  label: string;
  x: number;
};

const SEMITONES = [0, 2, 4, 5, 7, 9, 11, 12]; // white-key offsets within an octave
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const keyboardKeys = computed<KeyDef[]>(() => {
  const keys: KeyDef[] = [];
  let whiteIndex = 0;
  for (let i = 0; i < KEYBOARD_KEY_COUNT; i++) {
    const midiNote = KEYBOARD_OCTAVE_BASE + i;
    const inOctave = midiNote % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(inOctave);
    const octave = Math.floor(midiNote / 12) - 1;
    const label = `${NOTE_NAMES[inOctave]}${octave}`;
    if (isBlack) {
      // black key sits between whiteIndex-1 and whiteIndex
      keys.push({ midi: midiNote, white: false, label, x: whiteIndex - 0.35 });
    } else {
      keys.push({ midi: midiNote, white: true, label, x: whiteIndex });
      whiteIndex += 1;
    }
  }
  return keys;
});

const whiteKeyCount = computed(() => keyboardKeys.value.filter((k) => k.white).length);

const inputPorts = computed<MidiPortMeta[]>(() => midi.ports.filter((p) => p.kind === "input"));

const targetPortKey = ref<string>(inputPorts.value[0] ? portKey(inputPorts.value[0]) : "");
const velocity = ref(96);
const channel = ref(0);
const ccController = ref(7); // = main volume by default
const ccValue = ref(64);
const pitchBend = ref(0); // -8192 .. +8191
const program = ref(0);
const pressure = ref(0);

const pressedKeys = ref<Set<number>>(new Set());

const sendEvent = (event: MidiEvent): void => {
  if (!targetPortKey.value) return;
  midi.injectMidi(targetPortKey.value, event);
};

const onKeyDown = (midiNote: number): void => {
  if (pressedKeys.value.has(midiNote)) return;
  pressedKeys.value.add(midiNote);
  sendEvent({ type: "noteOn", channel: channel.value, note: midiNote, velocity: velocity.value });
};

const onKeyUp = (midiNote: number): void => {
  if (!pressedKeys.value.has(midiNote)) return;
  pressedKeys.value.delete(midiNote);
  sendEvent({ type: "noteOff", channel: channel.value, note: midiNote, velocity: 0 });
};

const onKeyLeave = (midiNote: number): void => {
  if (pressedKeys.value.has(midiNote)) onKeyUp(midiNote);
};

const sendCc = (): void => {
  sendEvent({
    type: "cc",
    channel: channel.value,
    controller: ccController.value,
    value: ccValue.value,
  });
};
const sendPitchBend = (): void => {
  sendEvent({ type: "pitchBend", channel: channel.value, value: pitchBend.value });
};
const sendProgramChange = (): void => {
  sendEvent({ type: "programChange", channel: channel.value, program: program.value });
};
const sendChannelPressure = (): void => {
  sendEvent({ type: "channelPressure", channel: channel.value, pressure: pressure.value });
};

const formatEventBody = (e: MidiEvent): string => {
  switch (e.type) {
    case "noteOn":
    case "noteOff":
      return `ch ${e.channel} · note ${e.note} (${noteLabel(e.note)}) · vel ${e.velocity}`;
    case "cc":
      return `ch ${e.channel} · cc ${e.controller} · val ${e.value}`;
    case "pitchBend":
      return `ch ${e.channel} · val ${e.value}`;
    case "programChange":
      return `ch ${e.channel} · prog ${e.program}`;
    case "channelPressure":
      return `ch ${e.channel} · pressure ${e.pressure}`;
  }
};

const noteLabel = (note: number): string => {
  const inOctave = note % 12;
  const octave = Math.floor(note / 12) - 1;
  return `${NOTE_NAMES[inOctave]}${octave}`;
};

const formatTs = (ms: number): string => {
  const d = new Date(ms);
  return (
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:` +
    `${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
  );
};

const directionLabel: Record<string, string> = {
  in: "↓ in",
  out: "↑ out",
  inject: "→ inject",
};

const WHITE_W = 32;
const WHITE_H = 110;
const BLACK_W = 20;
const BLACK_H = 72;

const keyboardWidth = computed(() => whiteKeyCount.value * WHITE_W);
</script>

<template>
  <div class="midi-view">
    <header class="view-header">
      <div class="view-title">MIDI</div>
      <div class="view-meta">
        <span class="u-pill">{{ midi.ports.length }} ports</span>
        <span class="u-pill u-pill--accent">{{ midi.log.value.length }} log entries</span>
      </div>
    </header>

    <div class="view-body">
      <!-- ─── Ports table ─── -->
      <section class="ports-section">
        <header class="section-head">
          <span class="section-title">Ports</span>
          <span class="section-meta mono">{{ midi.ports.length }} declared</span>
        </header>

        <div class="ports-table">
          <div class="port-row port-row-head">
            <div class="cell c-port">port</div>
            <div class="cell c-kind">kind</div>
            <div class="cell c-capacity">capacity</div>
            <div class="cell c-overflow">overflow</div>
            <div class="cell c-last">last event</div>
          </div>
          <div v-for="port in midi.ports" :key="portKey(port)" class="port-row">
            <div class="cell c-port mono">{{ portKey(port) }}</div>
            <div class="cell c-kind">
              <span
                class="u-pill"
                :class="port.kind === 'input' ? 'u-pill--accent' : 'kind-pill-midi'"
              >
                {{ port.kind }}
              </span>
            </div>
            <div class="cell c-capacity mono">{{ port.capacity }}</div>
            <div class="cell c-overflow mono">
              {{ midi.overflowMock.value[portKey(port)] ?? 0 }}
            </div>
            <div class="cell c-last mono">
              <template v-if="midi.lastEventByPort.value[portKey(port)]">
                <span class="last-event-type">
                  {{ midi.lastEventByPort.value[portKey(port)]!.event.type }}
                </span>
                <span class="last-event-body">
                  {{ formatEventBody(midi.lastEventByPort.value[portKey(port)]!.event) }}
                </span>
              </template>
              <template v-else>
                <span class="last-event-idle">—</span>
              </template>
            </div>
          </div>
        </div>
      </section>

      <!-- ─── Inject panel ─── -->
      <section class="inject-section">
        <header class="section-head">
          <span class="section-title">Virtual keyboard inject</span>
          <span class="section-meta mono">dev only · routed via mock RPC</span>
        </header>

        <div class="inject-controls">
          <label class="control">
            <span class="control-label">target port</span>
            <select v-model="targetPortKey" class="repr-select">
              <option v-for="port in inputPorts" :key="portKey(port)" :value="portKey(port)">
                {{ portKey(port) }}
              </option>
            </select>
          </label>
          <label class="control">
            <span class="control-label">channel</span>
            <input v-model.number="channel" type="number" min="0" max="15" class="num-input" />
          </label>
          <label class="control">
            <span class="control-label">velocity</span>
            <input v-model.number="velocity" type="range" min="0" max="127" />
            <span class="control-val mono">{{ velocity }}</span>
          </label>
        </div>

        <div class="keyboard-wrap" :style="{ width: `${keyboardWidth}px` }">
          <div class="keyboard-whites">
            <button
              v-for="key in keyboardKeys.filter((k) => k.white)"
              :key="key.midi"
              type="button"
              class="key-white"
              :class="{ pressed: pressedKeys.has(key.midi) }"
              :style="{
                left: `${key.x * WHITE_W}px`,
                width: `${WHITE_W}px`,
                height: `${WHITE_H}px`,
              }"
              @mousedown="onKeyDown(key.midi)"
              @mouseup="onKeyUp(key.midi)"
              @mouseleave="onKeyLeave(key.midi)"
            >
              <span class="key-label">{{ key.label }}</span>
            </button>
          </div>
          <div class="keyboard-blacks">
            <button
              v-for="key in keyboardKeys.filter((k) => !k.white)"
              :key="key.midi"
              type="button"
              class="key-black"
              :class="{ pressed: pressedKeys.has(key.midi) }"
              :style="{
                left: `${key.x * WHITE_W + WHITE_W - BLACK_W / 2}px`,
                width: `${BLACK_W}px`,
                height: `${BLACK_H}px`,
              }"
              @mousedown="onKeyDown(key.midi)"
              @mouseup="onKeyUp(key.midi)"
              @mouseleave="onKeyLeave(key.midi)"
            ></button>
          </div>
        </div>

        <div class="cc-row">
          <label class="control">
            <span class="control-label">CC #</span>
            <input
              v-model.number="ccController"
              type="number"
              min="0"
              max="127"
              class="num-input"
            />
          </label>
          <label class="control">
            <span class="control-label">CC value</span>
            <input v-model.number="ccValue" type="range" min="0" max="127" />
            <span class="control-val mono">{{ ccValue }}</span>
          </label>
          <button class="u-btn" @click="sendCc">Send CC</button>
        </div>

        <div class="cc-row">
          <label class="control">
            <span class="control-label">Pitch bend</span>
            <input v-model.number="pitchBend" type="range" min="-8192" max="8191" />
            <span class="control-val mono">{{ pitchBend }}</span>
          </label>
          <button class="u-btn" @click="sendPitchBend">Send pitch bend</button>
        </div>

        <div class="cc-row">
          <label class="control">
            <span class="control-label">Program</span>
            <input v-model.number="program" type="number" min="0" max="127" class="num-input" />
          </label>
          <button class="u-btn" @click="sendProgramChange">Program change</button>
          <label class="control">
            <span class="control-label">Pressure</span>
            <input v-model.number="pressure" type="range" min="0" max="127" />
            <span class="control-val mono">{{ pressure }}</span>
          </label>
          <button class="u-btn" @click="sendChannelPressure">Channel pressure</button>
        </div>
      </section>

      <!-- ─── Log ─── -->
      <section class="log-section">
        <header class="section-head">
          <span class="section-title">Event log</span>
          <span class="section-meta mono"
            >most recent first · last {{ midi.log.value.length }}</span
          >
        </header>

        <ul class="log-list">
          <li v-if="midi.log.value.length === 0" class="empty">No traffic yet.</li>
          <li
            v-for="entry in midi.log.value"
            :key="entry.id"
            class="log-row"
            :class="`direction-${entry.direction}`"
          >
            <span class="log-ts mono">{{ formatTs(entry.ts) }}</span>
            <span class="log-dir mono">{{ directionLabel[entry.direction] }}</span>
            <span class="log-port mono">{{ entry.portKey }}</span>
            <span class="log-type">{{ entry.event.type }}</span>
            <span class="log-body mono">{{ formatEventBody(entry.event) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.midi-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--u-border);
  background: var(--u-bg-elev-1);
}

.view-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--u-text);
}

.view-meta {
  display: flex;
  gap: 6px;
}

.view-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--u-text);
}

.section-meta {
  font-size: 11px;
  color: var(--u-text-dim);
}

/* ── Ports table ── */

.ports-section {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 14px 12px;
}

.ports-table {
  display: flex;
  flex-direction: column;
}

.port-row {
  display: grid;
  grid-template-columns: 1.6fr 0.6fr 0.6fr 0.6fr 2.4fr;
  gap: 10px;
  padding: 6px 4px;
  align-items: center;
  border-bottom: 1px solid var(--u-border);
  font-size: 12px;
}

.port-row:last-child {
  border-bottom: 0;
}

.port-row-head {
  color: var(--u-text-dim);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}

.cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-overflow {
  text-align: right;
}

.last-event-type {
  color: var(--u-accent);
  font-weight: 600;
  margin-right: 6px;
}

.last-event-body {
  color: var(--u-text-muted);
}

.last-event-idle {
  color: var(--u-text-dim);
}

.kind-pill-midi {
  background: rgba(255, 99, 166, 0.18);
  color: var(--u-midi);
}

/* ── Inject panel ── */

.inject-section {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inject-controls,
.cc-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--u-text-muted);
}

.control-label {
  color: var(--u-text-dim);
}

.control-val {
  min-width: 36px;
  color: var(--u-text);
  text-align: right;
}

.repr-select,
.num-input {
  background: var(--u-bg-elev-2);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  color: var(--u-text);
  font-size: 12px;
  padding: 3px 8px;
  font-family: var(--u-sans);
}

.num-input {
  width: 60px;
}

.repr-select {
  min-width: 180px;
}

input[type="range"] {
  width: 160px;
}

/* ── Keyboard ── */

.keyboard-wrap {
  position: relative;
  height: 110px;
  background: var(--u-bg);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  overflow: hidden;
  user-select: none;
}

.keyboard-whites {
  position: relative;
  height: 110px;
}

.keyboard-blacks {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.key-white {
  position: absolute;
  top: 0;
  background: #f5f5f5;
  border: 1px solid #ccc;
  border-radius: 0 0 3px 3px;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 4px;
}

.key-white.pressed {
  background: var(--u-accent);
}

.key-label {
  font-size: 8.5px;
  color: #888;
  font-family: var(--u-mono);
}

.key-white.pressed .key-label {
  color: #0f1115;
  font-weight: 700;
}

.key-black {
  position: absolute;
  top: 0;
  background: #1a1a1a;
  border: 1px solid #000;
  border-radius: 0 0 3px 3px;
  cursor: pointer;
  pointer-events: auto;
  padding: 0;
}

.key-black.pressed {
  background: var(--u-unworklet);
}

/* ── Log ── */

.log-section {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 14px 12px;
}

.log-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  max-height: 280px;
  overflow-y: auto;
}

.log-row {
  display: grid;
  grid-template-columns: 100px 60px 1.2fr 0.8fr 1.6fr;
  gap: 10px;
  padding: 4px 4px;
  align-items: center;
  border-bottom: 1px solid var(--u-border);
  font-size: 11.5px;
}

.log-row:last-child {
  border-bottom: 0;
}

.log-ts {
  color: var(--u-text-dim);
  font-size: 10.5px;
}

.log-dir {
  font-size: 10.5px;
}

.direction-in .log-dir {
  color: var(--u-accent);
}

.direction-out .log-dir {
  color: var(--u-success);
}

.direction-inject .log-dir {
  color: var(--u-warn);
}

.log-port {
  color: var(--u-text-muted);
}

.log-type {
  color: var(--u-text);
  font-weight: 600;
  font-size: 11px;
}

.log-body {
  color: var(--u-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 10px 6px;
  color: var(--u-text-dim);
  font-size: 12px;
}
</style>
