<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import RangeSlider from "../components/RangeSlider.vue";
import {
  type MidiEvent,
  type MidiEventInput,
  type MidiPortMeta,
  portKey,
  useMockMidi,
} from "../composables/useMockMidi";

const midi = useMockMidi();

// Keyboard window = 2 octaves (25 keys) starting at the configurable octave base.
const KEYBOARD_KEY_COUNT = 25;
// Octave base in MIDI note number. C4 = 60. Z / X shifts in 12-semitone steps.
const octaveBase = ref(60);

type KeyDef = {
  midi: number;
  white: boolean;
  label: string;
  x: number;
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const keyboardKeys = computed<KeyDef[]>(() => {
  const keys: KeyDef[] = [];
  let whiteIndex = 0;
  for (let i = 0; i < KEYBOARD_KEY_COUNT; i++) {
    const midiNote = octaveBase.value + i;
    if (midiNote < 0 || midiNote > 127) continue;
    const inOctave = midiNote % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(inOctave);
    const octave = Math.floor(midiNote / 12) - 1;
    const label = `${NOTE_NAMES[inOctave]}${octave}`;
    if (isBlack) {
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
const ccController = ref(1); // = modulation wheel (most common dev test target)
const ccValue = ref(64);
const pitchBend = ref(0); // -8192 .. +8191; bend wheel springs back to 0 on release
const program = ref(0);
const pressure = ref(0);

const pressedKeys = ref<Set<number>>(new Set());

const sendEvent = (event: MidiEventInput): void => {
  if (!targetPortKey.value) return;
  midi.injectMidi(targetPortKey.value, event);
};

// ──────────────────────────────────────────────────────────────────
// Note triggers (mouse + PC keyboard share the same noteOn / noteOff path)
// ──────────────────────────────────────────────────────────────────

const triggerNoteOn = (midiNote: number, vel: number): void => {
  if (pressedKeys.value.has(midiNote)) return;
  pressedKeys.value.add(midiNote);
  sendEvent({ type: "noteOn", channel: channel.value, note: midiNote, velocity: vel });
};

const triggerNoteOff = (midiNote: number): void => {
  if (!pressedKeys.value.has(midiNote)) return;
  pressedKeys.value.delete(midiNote);
  sendEvent({ type: "noteOff", channel: channel.value, note: midiNote, velocity: 0 });
};

const onKeyDown = (midiNote: number): void => triggerNoteOn(midiNote, velocity.value);
const onKeyUp = (midiNote: number): void => triggerNoteOff(midiNote);
const onKeyLeave = (midiNote: number): void => {
  if (pressedKeys.value.has(midiNote)) triggerNoteOff(midiNote);
};

// ──────────────────────────────────────────────────────────────────
// Continuous controllers — auto-send on slider input (no Send button).
// Pitch bend additionally springs back to 0 on pointer release (= hardware
// bend wheel behaviour).
// ──────────────────────────────────────────────────────────────────

// Use a `watch` per controller ref instead of `@input` on the slider. Reason:
// @input fires synchronously during native drag; if its handler causes Vue to
// rerender something heavy (= log list grows on every inject), the renderer
// can momentarily re-patch the slider element and the browser drops the
// in-flight drag. watch() runs in a microtask after the input event resolves,
// so the slider keeps its drag intact and our side-effect (inject) lands once
// per logical value change.
watch(ccValue, () => {
  sendEvent({
    type: "cc",
    channel: channel.value,
    controller: ccController.value,
    value: ccValue.value,
  });
});

watch(pitchBend, (v) => {
  sendEvent({ type: "pitchBend", channel: channel.value, value: v });
});

watch(pressure, (v) => {
  sendEvent({ type: "channelPressure", channel: channel.value, pressure: v });
});

const onPitchBendRelease = (): void => {
  if (pitchBend.value === 0) return;
  // Triggers the pitchBend watcher above with value=0.
  pitchBend.value = 0;
};

const sendProgramChange = (): void => {
  sendEvent({ type: "programChange", channel: channel.value, program: program.value });
};

// ──────────────────────────────────────────────────────────────────
// Panic: clear every pressed note + broadcast "All Notes Off" (CC 123 = 0)
// on every channel. Recovers from stuck notes (= a worklet that missed a
// noteOff because of overflow, or a PC key released while window unfocused).
// ──────────────────────────────────────────────────────────────────

const panic = (): void => {
  if (!targetPortKey.value) return;
  for (const note of [...pressedKeys.value]) {
    sendEvent({ type: "noteOff", channel: channel.value, note, velocity: 0 });
  }
  pressedKeys.value.clear();
  physicalKeyToMidi.clear();
  for (let ch = 0; ch < 16; ch++) {
    sendEvent({ type: "cc", channel: ch, controller: 123, value: 0 });
  }
};

// ──────────────────────────────────────────────────────────────────
// PC keyboard → piano mapping (standard A/S/D… layout, W/E… for sharps)
// ──────────────────────────────────────────────────────────────────

const PC_KEY_TO_OFFSET: Record<string, number> = {
  // white keys (C major: A=C, S=D, D=E, F=F, G=G, H=A, J=B, K=C, L=D)
  a: 0,
  s: 2,
  d: 4,
  f: 5,
  g: 7,
  h: 9,
  j: 11,
  k: 12,
  l: 14,
  // black keys (W=C#, E=D#, T=F#, Y=G#, U=A#, O=C#, P=D#)
  w: 1,
  e: 3,
  t: 6,
  y: 8,
  u: 10,
  o: 13,
  p: 15,
};

const SOFT_VELOCITY = 40;
const physicalKeyToMidi = new Map<string, number>();

const midiToPhysicalKey = computed<Record<number, string>>(() => {
  const out: Record<number, string> = {};
  for (const [key, offset] of Object.entries(PC_KEY_TO_OFFSET)) {
    const note = octaveBase.value + offset;
    if (note >= 0 && note <= 127) out[note] = key.toUpperCase();
  }
  return out;
});

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
};

const onWindowKeyDown = (event: KeyboardEvent): void => {
  // Don't hijack the user's typing in number inputs / selects / etc.
  if (isTypingTarget(event.target)) return;
  // Leave browser shortcuts alone (Cmd+R, Ctrl+S, Alt+anything).
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.repeat) return;

  const key = event.key.toLowerCase();

  // Octave shift
  if (key === "z") {
    octaveBase.value = Math.max(0, octaveBase.value - 12);
    event.preventDefault();
    return;
  }
  if (key === "x") {
    octaveBase.value = Math.min(108, octaveBase.value + 12);
    event.preventDefault();
    return;
  }

  const offset = PC_KEY_TO_OFFSET[key];
  if (offset === undefined) return;
  event.preventDefault();
  if (physicalKeyToMidi.has(key)) return;

  const note = octaveBase.value + offset;
  if (note < 0 || note > 127) return;
  physicalKeyToMidi.set(key, note);
  const vel = event.shiftKey ? SOFT_VELOCITY : velocity.value;
  triggerNoteOn(note, vel);
};

const onWindowKeyUp = (event: KeyboardEvent): void => {
  const key = event.key.toLowerCase();
  const note = physicalKeyToMidi.get(key);
  if (note === undefined) return;
  physicalKeyToMidi.delete(key);
  triggerNoteOff(note);
};

onMounted(() => {
  window.addEventListener("keydown", onWindowKeyDown);
  window.addEventListener("keyup", onWindowKeyUp);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeyDown);
  window.removeEventListener("keyup", onWindowKeyUp);
});

// ──────────────────────────────────────────────────────────────────
// CC reference: dev-friendly names for the most common controller numbers.
// Backs the <datalist> on the CC # input — devs can pick by name or type a
// raw 0-127 number.
// ──────────────────────────────────────────────────────────────────

const CC_STANDARDS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: "Modulation" },
  { id: 2, name: "Breath" },
  { id: 7, name: "Volume" },
  { id: 10, name: "Pan" },
  { id: 11, name: "Expression" },
  { id: 64, name: "Sustain pedal" },
  { id: 65, name: "Portamento" },
  { id: 66, name: "Sostenuto" },
  { id: 67, name: "Soft pedal" },
  { id: 71, name: "Resonance" },
  { id: 74, name: "Cutoff" },
  { id: 91, name: "Reverb send" },
  { id: 93, name: "Chorus send" },
  { id: 120, name: "All sound off" },
  { id: 121, name: "Reset controllers" },
  { id: 123, name: "All notes off" },
];

const ccCurrentName = computed(
  () => CC_STANDARDS.find((c) => c.id === ccController.value)?.name ?? "",
);

// ──────────────────────────────────────────────────────────────────
// Event log formatting + direction filter
// ──────────────────────────────────────────────────────────────────

const formatEventBody = (e: MidiEvent): string => {
  const base = `ch ${e.channel} · sample ${e.atSample}`;
  switch (e.type) {
    case "noteOn":
    case "noteOff":
      return `${base} · note ${e.note} (${noteLabel(e.note)}) · vel ${e.velocity}`;
    case "cc":
      return `${base} · cc ${e.controller} · val ${e.value}`;
    case "pitchBend":
      return `${base} · val ${e.value}`;
    case "programChange":
      return `${base} · prog ${e.program}`;
    case "channelPressure":
      return `${base} · pressure ${e.pressure}`;
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

const directionFilter = ref<Record<"in" | "out" | "inject", boolean>>({
  in: true,
  out: true,
  inject: true,
});

const filteredLog = computed(() =>
  midi.log.value.filter((e) => directionFilter.value[e.direction]),
);

const toggleDirection = (d: "in" | "out" | "inject"): void => {
  directionFilter.value = { ...directionFilter.value, [d]: !directionFilter.value[d] };
};

// ──────────────────────────────────────────────────────────────────
// Overflow alert (= dropped events on the currently-targeted input port)
// ──────────────────────────────────────────────────────────────────

const overflowForTarget = computed(() => midi.overflowMock.value[targetPortKey.value] ?? 0);

const resetOverflowForTarget = (): void => midi.resetOverflow(targetPortKey.value);

// ──────────────────────────────────────────────────────────────────
// Keyboard geometry
// ──────────────────────────────────────────────────────────────────

const WHITE_W = 32;
const WHITE_H = 110;
const BLACK_W = 20;
const BLACK_H = 72;

const keyboardWidth = computed(() => whiteKeyCount.value * WHITE_W);

const octaveLabel = computed(() => `C${Math.floor(octaveBase.value / 12) - 1}`);
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
      <!-- ─── Event log ─── -->
      <section class="log-section">
        <header class="section-head">
          <span class="section-title">Event log</span>
          <div class="log-filter">
            <button
              v-for="d in ['in', 'out', 'inject'] as const"
              :key="d"
              type="button"
              class="log-filter-chip"
              :class="[`chip-${d}`, { 'chip-active': directionFilter[d] }]"
              :title="`Toggle ${directionLabel[d]} events`"
              @click="toggleDirection(d)"
            >
              {{ directionLabel[d] }}
            </button>
            <span class="section-meta mono"
              >{{ filteredLog.length }} / {{ midi.log.value.length }}</span
            >
          </div>
        </header>

        <ul class="log-list">
          <li v-if="filteredLog.length === 0" class="empty">No traffic yet.</li>
          <li
            v-for="entry in filteredLog"
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

      <!-- ─── Inject panel ─── -->
      <section class="inject-section">
        <header class="section-head">
          <span class="section-title">Virtual keyboard inject</span>
          <span class="section-meta mono">dev only · routed via mock RPC</span>
        </header>

        <div class="inject-split">
          <div class="inject-left">
            <!-- Routing (target port + channel — applies to everything below) -->
            <div class="inject-routing">
              <label class="control">
                <span class="control-label">target port</span>
                <select v-model="targetPortKey" class="repr-select">
                  <option v-for="port in inputPorts" :key="portKey(port)" :value="portKey(port)">
                    {{ portKey(port) }}
                  </option>
                </select>
              </label>
              <span
                v-if="overflowForTarget > 0"
                class="overflow-badge"
                :title="`${overflowForTarget} event(s) dropped on ${targetPortKey} — your injection rate is exceeding port capacity`"
              >
                ⚠ {{ overflowForTarget }} dropped
                <button
                  type="button"
                  class="overflow-reset"
                  title="Reset counter"
                  @click="resetOverflowForTarget"
                >
                  ×
                </button>
              </span>
              <label class="control">
                <span class="control-label">channel</span>
                <input v-model.number="channel" type="number" min="0" max="15" class="num-input" />
              </label>
              <button
                type="button"
                class="u-btn panic-btn"
                title="Send All Notes Off (CC 123 = 0) on every channel + clear stuck notes"
                @click="panic"
              >
                ⏻ Panic
              </button>
            </div>

            <!-- Keyboard + velocity (velocity drives the next noteOn).
             PC key labels are overlaid on each playable piano key (A/S/D… etc).
             Z / X shift the octave; Shift held = soft velocity (40). -->
            <div class="inject-keyboard">
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
                    <span v-if="midiToPhysicalKey[key.midi]" class="key-pc-label">
                      {{ midiToPhysicalKey[key.midi] }}
                    </span>
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
                  >
                    <span
                      v-if="midiToPhysicalKey[key.midi]"
                      class="key-pc-label key-pc-label--black"
                    >
                      {{ midiToPhysicalKey[key.midi] }}
                    </span>
                  </button>
                </div>
              </div>

              <div class="keyboard-hint mono">
                <span>octave: {{ octaveLabel }}</span>
                <span>Z / X = shift</span>
                <span>Shift = soft vel</span>
              </div>
            </div>
          </div>

          <div class="inject-right">
            <!-- Controllers grid: label | aux # | slider | value | action.
             Continuous controls (CC / Pitch bend / Pressure) auto-send on
             slider input so the dev can modulate while playing notes. Pitch
             bend additionally springs back to 0 on pointer release.
             Program change is discrete → keeps its Send button. -->
            <div class="inject-controllers">
              <span class="ctrl-row-label">Velocity</span>
              <div class="ctrl-row-aux"></div>
              <RangeSlider v-model="velocity" :min="0" :max="127" />
              <span class="ctrl-row-value mono">{{ velocity }}</span>

              <span class="ctrl-row-label">CC</span>
              <div class="ctrl-row-aux">
                <span class="ctrl-row-aux-label">#</span>
                <input
                  v-model.number="ccController"
                  type="number"
                  min="0"
                  max="127"
                  list="cc-standards"
                  class="num-input"
                />
                <span v-if="ccCurrentName" class="ctrl-row-aux-hint">{{ ccCurrentName }}</span>
              </div>
              <RangeSlider v-model="ccValue" :min="0" :max="127" />
              <span class="ctrl-row-value mono">{{ ccValue }}</span>

              <span class="ctrl-row-label">Pitch bend</span>
              <div class="ctrl-row-aux"></div>
              <RangeSlider
                v-model="pitchBend"
                :min="-8192"
                :max="8191"
                center-origin
                @release="onPitchBendRelease"
              />
              <span class="ctrl-row-value mono">{{ pitchBend }}</span>

              <span class="ctrl-row-label">Pressure</span>
              <div class="ctrl-row-aux"></div>
              <RangeSlider v-model="pressure" :min="0" :max="127" />
              <span class="ctrl-row-value mono">{{ pressure }}</span>

              <span class="ctrl-row-label">Program</span>
              <div class="ctrl-row-aux">
                <span class="ctrl-row-aux-label">#</span>
                <input v-model.number="program" type="number" min="0" max="127" class="num-input" />
              </div>
              <button class="u-btn ctrl-row-send" @click="sendProgramChange">Send</button>
              <span></span>
            </div>

            <!-- Datalist powers autocomplete on the CC # input above. -->
            <datalist id="cc-standards">
              <option v-for="cc in CC_STANDARDS" :key="cc.id" :value="cc.id">{{ cc.name }}</option>
            </datalist>
          </div>
        </div>
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
  font-family: var(--u-headline);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
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
  font-family: var(--u-headline);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--u-text);
}

.section-meta {
  font-size: 11px;
  color: var(--u-text-dim);
}

/* ── Inject panel ── */

.inject-section {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Split: left = play-related (routing + keyboard + velocity),
          right = send-on-demand controllers (CC / Pitch / Pressure / Program). */
.inject-split {
  display: grid;
  grid-template-columns: auto minmax(360px, 1fr);
  gap: 40px;
  align-items: start;
}

.inject-left,
.inject-right {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

/* ── Routing (target port + channel) ── */

.inject-routing {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: center;
}

/* ── Overflow alert (next to target port dropdown) ── */

.overflow-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba(255, 180, 171, 0.12);
  border: 1px solid var(--u-danger);
  border-radius: var(--u-radius-sm);
  color: var(--u-danger);
  font-family: var(--u-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.overflow-reset {
  margin-left: 2px;
  padding: 0 4px;
  background: transparent;
  border: 0;
  color: var(--u-danger);
  font-family: var(--u-mono);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}

.overflow-reset:hover {
  opacity: 1;
}

/* ── Panic ── */

.panic-btn {
  margin-left: auto;
  border-color: var(--u-danger);
  color: var(--u-danger);
  letter-spacing: 0.04em;
}

.panic-btn:hover {
  background: rgba(255, 180, 171, 0.1);
  border-color: var(--u-danger);
  color: var(--u-danger);
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

/* ── Keyboard + velocity ── */

.inject-keyboard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.keyboard-hint {
  display: flex;
  gap: 14px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--u-text-dim);
}

/* ── Controllers grid ──
   Single grid for CC / Pitch bend / Pressure / Program so every row's
   label / aux input / slider / value readout / Send button line up
   vertically across rows. */

/* Controllers grid:
   col 1 = row label,
   col 2 = aux (CC #/Program # input + standard-name hint),
   col 3 = slider (or Send button on the discrete Program row),
   col 4 = current value readout.
   Col 2 sized so the longest standard CC name (= "Reset controllers") still
   fits next to the # input without overlapping the slider. */
.inject-controllers {
  display: grid;
  grid-template-columns: 90px 200px minmax(180px, 1fr) 50px;
  gap: 10px 12px;
  align-items: center;
}

.ctrl-row-send {
  justify-self: start;
}

.ctrl-row-label {
  font-size: 11.5px;
  color: var(--u-text-muted);
}

.ctrl-row-aux {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--u-text-dim);
}

.ctrl-row-aux-label {
  color: var(--u-text-dim);
}

.ctrl-row-aux-hint {
  font-size: 9.5px;
  color: var(--u-text-dim);
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}

.ctrl-row-slider {
  width: 100%;
}

.ctrl-row-value {
  text-align: right;
  font-size: 11px;
  color: var(--u-text);
  font-family: var(--u-mono);
}

.ctrl-row-action {
  text-align: center;
  font-size: 10.5px;
}

/* Default <input type="range"> width (= used by velocity + controllers). */
input[type="range"] {
  width: 100%;
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
  background: floralwhite;
  border: 1px solid var(--u-border-strong);
  border-radius: 0 0 3px 3px;
  cursor: pointer;
  padding: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding-bottom: 4px;
  gap: 2px;
}

.key-white.pressed {
  /* Darker shade of the floralwhite idle color (same warm hue, lower lightness)
     so the pressed state reads as "key depressed, catching shadow" rather than
     "becomes brighter". */
  background: wheat;
  border-color: burlywood;
}

.key-label {
  font-size: 8.5px;
  color: var(--u-text-muted);
  font-family: var(--u-mono);
  letter-spacing: 0.04em;
}

.key-white.pressed .key-label {
  color: #000;
  font-weight: 700;
}

.key-black {
  position: absolute;
  top: 0;
  background: var(--u-bg);
  border: 1px solid var(--u-border-strong);
  border-radius: 0 0 3px 3px;
  cursor: pointer;
  pointer-events: auto;
  padding: 0;
}

.key-black.pressed {
  background: var(--u-text);
  border-color: var(--u-text);
}

/* PC-key labels overlaid on playable piano keys (A / S / D / W / E … etc).
   White keys = dark text on light key (floralwhite bg → black label),
   black keys = light text on dark key (floralwhite label on dark overlay). */
.key-pc-label {
  font-family: var(--u-mono);
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #000;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 2px;
  padding: 1px 3px;
  pointer-events: none;
}

.key-pc-label--black {
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  color: var(--u-text);
  background: rgba(255, 250, 240, 0.16);
}

.key-white.pressed .key-pc-label {
  background: rgba(0, 0, 0, 0.22);
  color: #000;
}

/* ── Log ── */

.log-section {
  background: var(--u-bg-elev-1);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius);
  padding: 10px 14px 12px;
}

/* ── Log filter chips (toggle in / out / inject visibility) ── */

.log-filter {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-filter-chip {
  padding: 2px 8px;
  background: var(--u-bg-elev-2);
  border: 1px solid var(--u-border);
  border-radius: var(--u-radius-sm);
  color: var(--u-text-dim);
  font-family: var(--u-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  cursor: pointer;
  opacity: 0.55;
  transition:
    opacity 80ms,
    border-color 80ms,
    background 80ms;
}

.log-filter-chip.chip-active {
  opacity: 1;
}

.log-filter-chip.chip-in.chip-active {
  border-color: #82bfff;
  color: #82bfff;
}

.log-filter-chip.chip-out.chip-active {
  border-color: #62d18a;
  color: #62d18a;
}

.log-filter-chip.chip-inject.chip-active {
  border-color: var(--u-warn);
  color: var(--u-warn);
}

.log-filter-chip:hover {
  opacity: 1;
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
