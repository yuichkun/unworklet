import { computed, onScopeDispose, ref, watch } from "vue";

// = integrated real audio chain simulation =
// BPM 120 / 1/8 @ 48 kHz = 1 step ≈ 0.125 s
const STEP_DURATION_S = 0.125;
const PATTERN_LEN = 16;
const VOICE_COUNT = 8;
const ROOT_NOTE = 60; // C4
const HISTORY_LEN = 150; // ≈ 5 s @ 30 fps for sparklines

const PATTERN_VALUES = [0, 4, 7, 12, 16, 19, 24, 19, 16, 12, 7, 4, 0, -5, -8, -12];

// Roland device control sysex header pattern
const SYSEX_VALUES = [
  0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x01, 0x00, 0x4c, 0x00, 0x00, 0x00, 0x00, 0xf7,
];

const phase = ref(0); // seconds, global animation clock
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
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  lastTs = null;
};

// ─────────────────────────────────────────────────────────────────────
// Derived slot values (= integrated chain)
// ─────────────────────────────────────────────────────────────────────

const stepIdx = computed(() => Math.floor(phase.value / STEP_DURATION_S) % PATTERN_LEN);

const activeVoices = computed(() => {
  const cycle = Math.sin(phase.value * 0.4) * 0.5 + 0.5;
  return Math.max(1, Math.min(VOICE_COUNT, Math.round(1 + cycle * 4)));
});

const polysynthMeterL = computed(() => {
  const av = activeVoices.value;
  const env = 0.4 + 0.3 * Math.sin(phase.value * 1.2);
  return Math.max(0, Math.min(0.95, (av / VOICE_COUNT) * env + 0.2));
});

const polysynthMeterR = computed(() => {
  const av = activeVoices.value;
  const env = 0.4 + 0.3 * Math.sin(phase.value * 1.2 + 0.3);
  return Math.max(0, Math.min(0.95, (av / VOICE_COUNT) * env + 0.2));
});

const limiterGainReductionDb = computed(() => {
  const peak = Math.max(polysynthMeterL.value, polysynthMeterR.value);
  const ceiling = 0.7;
  if (peak <= ceiling) return 0;
  return -20 * Math.log10(peak / ceiling) * 0.5 - 0.5;
});

const limiterIsLimiting = computed(() => limiterGainReductionDb.value < -0.1);

const reverbWetMeter = computed(() => {
  const limited =
    Math.max(polysynthMeterL.value, polysynthMeterR.value) *
    Math.max(0.2, 1 + limiterGainReductionDb.value / 12);
  // Trailing release shape so reverb meter lags polysynth meter
  return Math.max(0, Math.min(0.95, limited * 0.7 + 0.1 + Math.sin(phase.value * 0.5) * 0.08));
});

const arpActivePattern = computed(() => true);

const polysynthVoiceGates = computed(() => {
  const av = activeVoices.value;
  return Array.from({ length: VOICE_COUNT }, (_, i) => i < av);
});

const arpPatternBuffer = new Int32Array(PATTERN_VALUES);
const arpLastSysexBuffer = new Uint8Array(SYSEX_VALUES);

// waveform = sum of active voice sines, modulated by ADSR envelope
const polysynthWaveform = computed(() => {
  const av = activeVoices.value;
  const baseNote = ROOT_NOTE + PATTERN_VALUES[stepIdx.value]!;
  const baseFreq = 440 * 2 ** ((baseNote - 69) / 12);
  const out = new Float32Array(1024);
  const envelope = 0.5 + 0.5 * Math.sin(phase.value * 2);
  for (let i = 0; i < 1024; i++) {
    let s = 0;
    for (let v = 0; v < av; v++) {
      const detune = 1 + (v - av / 2) * 0.002;
      s += Math.sin((i / 1024) * Math.PI * 2 * 8 * (baseFreq / 440) * detune) * 0.12;
    }
    out[i] = s * envelope;
  }
  return out;
});

// reverb spectrum = low-frequency-biased FFT bin shape
const reverbSpectrum = computed(() => {
  const out = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const norm = i / 512;
    const lowDecay = Math.exp(-norm * 3);
    out[i] = lowDecay * (0.5 + 0.5 * Math.sin(phase.value * 1.5 + i * 0.05));
  }
  return out;
});

// ─────────────────────────────────────────────────────────────────────
// Rolling history (= sparkline source for scalar slots)
// ─────────────────────────────────────────────────────────────────────

const histories = new Map<string, number[]>();
const pushHistory = (key: string, value: number): void => {
  let arr = histories.get(key);
  if (!arr) {
    arr = [];
    histories.set(key, arr);
  }
  arr.push(value);
  if (arr.length > HISTORY_LEN) arr.shift();
};

let lastHistTick = -1;
const HISTORY_INTERVAL_S = 1 / 30;

watch(phase, (t) => {
  if (lastHistTick >= 0 && t - lastHistTick < HISTORY_INTERVAL_S && t > lastHistTick) return;
  lastHistTick = t;
  pushHistory("arpeggiator.stepIdx", stepIdx.value);
  pushHistory("arpeggiator.activePattern", arpActivePattern.value ? 1 : 0);
  pushHistory("polysynth.activeVoices", activeVoices.value);
  pushHistory("polysynth.meterL", polysynthMeterL.value);
  pushHistory("polysynth.meterR", polysynthMeterR.value);
  pushHistory("limiter.gainReductionDb", limiterGainReductionDb.value);
  pushHistory("limiter.isLimiting", limiterIsLimiting.value ? 1 : 0);
  pushHistory("reverb.wetMeter", reverbWetMeter.value);
});

// ─────────────────────────────────────────────────────────────────────
// Public access by slot key
// ─────────────────────────────────────────────────────────────────────

export type SlotKey = string; // `${nodeId}.${slotName}`

export type SlotScalarValue = number | boolean;
export type SlotBufferValue = Float32Array | Int32Array | Uint8Array | boolean[];

export const getSlotScalar = (key: SlotKey): SlotScalarValue | undefined => {
  switch (key) {
    case "arpeggiator.stepIdx":
      return stepIdx.value;
    case "arpeggiator.activePattern":
      return arpActivePattern.value;
    case "polysynth.activeVoices":
      return activeVoices.value;
    case "polysynth.meterL":
      return polysynthMeterL.value;
    case "polysynth.meterR":
      return polysynthMeterR.value;
    case "limiter.gainReductionDb":
      return limiterGainReductionDb.value;
    case "limiter.isLimiting":
      return limiterIsLimiting.value;
    case "reverb.wetMeter":
      return reverbWetMeter.value;
    default:
      return undefined;
  }
};

export const getSlotBuffer = (key: SlotKey): SlotBufferValue | undefined => {
  switch (key) {
    case "arpeggiator.pattern":
      return arpPatternBuffer;
    case "arpeggiator.lastSysex":
      return arpLastSysexBuffer;
    case "polysynth.waveform":
      return polysynthWaveform.value;
    case "polysynth.voiceGates":
      return polysynthVoiceGates.value;
    case "reverb.spectrum":
      return reverbSpectrum.value;
    default:
      return undefined;
  }
};

export const getSlotHistory = (key: SlotKey): readonly number[] => {
  return histories.get(key) ?? [];
};

export const useLiveStateMock = () => {
  subscribers += 1;
  startLoop();
  onScopeDispose(() => {
    subscribers -= 1;
    if (subscribers <= 0) stopLoop();
  });
  return {
    phase,
    getSlotScalar,
    getSlotBuffer,
    getSlotHistory,
  };
};
