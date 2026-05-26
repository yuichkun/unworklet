import { computed, onScopeDispose, ref, watch } from "vue";

// Mock MIDI port surface across all unworklet nodes. Simulates a natural MIDI
// chain (= arpeggiator's `arpOut` emits noteOn/noteOff each step, polysynth's
// `keys` receives them) so the ports table + inject log show realistic traffic.
// Phase 6 末 尾 で `node.midi.<name>.diagnostics` + `client.call('unworklet:midi:send', ...)`
// に swap で UI 改 訂 不 要。

export type MidiPortKind = "input" | "output";

export type MidiPortMeta = {
  nodeId: string;
  portName: string;
  kind: MidiPortKind;
  capacity: number;
};

const PORTS: MidiPortMeta[] = [
  { nodeId: "arpeggiator", portName: "keys", kind: "input", capacity: 256 },
  { nodeId: "arpeggiator", portName: "arpOut", kind: "output", capacity: 256 },
  { nodeId: "polysynth", portName: "keys", kind: "input", capacity: 256 },
];

export const portKey = (p: MidiPortMeta): string => `${p.nodeId}.${p.portName}`;

export type MidiEvent =
  | { type: "noteOn"; channel: number; note: number; velocity: number }
  | { type: "noteOff"; channel: number; note: number; velocity: number }
  | { type: "cc"; channel: number; controller: number; value: number }
  | { type: "pitchBend"; channel: number; value: number }
  | { type: "programChange"; channel: number; program: number }
  | { type: "channelPressure"; channel: number; pressure: number };

export type MidiLogEntry = {
  id: number;
  ts: number;
  portKey: string;
  direction: "in" | "out" | "inject";
  event: MidiEvent;
};

const phase = ref(0);
let rafId: number | null = null;
let lastTs: number | null = null;
let subscribers = 0;

const tick = (ts: number): void => {
  if (lastTs === null) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  phase.value = (phase.value + dt) % 100_000;
  rafId = requestAnimationFrame(tick);
};
const startLoop = (): void => {
  if (rafId !== null) return;
  lastTs = null;
  rafId = requestAnimationFrame(tick);
};
const stopLoop = (): void => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  lastTs = null;
};

const PATTERN_NOTES = [60, 64, 67, 72, 76, 79, 84, 79, 76, 72, 67, 64, 60, 55, 52, 48];
const ARP_STEP_S = 0.125;
const LOG_LIMIT = 100;

const log = ref<MidiLogEntry[]>([]);
let logCounter = 0;
let lastStepEmitted = -1;
let lastNoteOnNote: number | null = null;
let baseTime: number | null = null;

const pushLog = (entry: Omit<MidiLogEntry, "id" | "ts">, simulatedTime: number): void => {
  log.value.unshift({ ...entry, id: ++logCounter, ts: simulatedTime });
  if (log.value.length > LOG_LIMIT) log.value = log.value.slice(0, LOG_LIMIT);
};

const emitArpStep = (t: number): void => {
  if (baseTime === null) baseTime = t;
  const elapsed = t - baseTime;
  const step = Math.floor(elapsed / ARP_STEP_S);
  if (step === lastStepEmitted) return;
  lastStepEmitted = step;
  const wallTs = Date.now();
  const note = PATTERN_NOTES[step % PATTERN_NOTES.length]!;
  if (lastNoteOnNote !== null) {
    const off: MidiEvent = { type: "noteOff", channel: 0, note: lastNoteOnNote, velocity: 0 };
    pushLog({ portKey: "arpeggiator.arpOut", direction: "out", event: off }, wallTs);
    pushLog({ portKey: "polysynth.keys", direction: "in", event: off }, wallTs);
  }
  const on: MidiEvent = { type: "noteOn", channel: 0, note, velocity: 96 };
  pushLog({ portKey: "arpeggiator.arpOut", direction: "out", event: on }, wallTs);
  pushLog({ portKey: "polysynth.keys", direction: "in", event: on }, wallTs);
  lastNoteOnNote = note;
};

watch(phase, (t) => emitArpStep(t));

const lastEventByPort = computed<Record<string, MidiLogEntry | undefined>>(() => {
  const out: Record<string, MidiLogEntry | undefined> = {};
  for (const port of PORTS) out[portKey(port)] = undefined;
  for (const entry of log.value) {
    if (!out[entry.portKey]) out[entry.portKey] = entry;
  }
  return out;
});

const overflowMock = ref<Record<string, number>>({
  "arpeggiator.keys": 0,
  "arpeggiator.arpOut": 0,
  "polysynth.keys": 0,
});

const injectMidi = (targetPortKey: string, event: MidiEvent): void => {
  pushLog({ portKey: targetPortKey, direction: "inject", event }, Date.now());
};

export const useMockMidi = () => {
  subscribers += 1;
  startLoop();
  onScopeDispose(() => {
    subscribers -= 1;
    if (subscribers <= 0) stopLoop();
  });
  return {
    phase,
    ports: PORTS,
    portKey,
    log: computed(() => log.value),
    overflowMock,
    lastEventByPort,
    injectMidi,
  };
};
