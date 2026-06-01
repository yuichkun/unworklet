import { computed, ref } from "vue";

export type NodeKind = "unworklet" | "standard";
export type NodeStatus = "ok" | "warning" | "errors";

export type AudioGraphNode = {
  id: string;
  label: string;
  kind: NodeKind;
  audioNodeType: string;
  status: NodeStatus;
  errorCount: number;
  col: number;
  row: number;
};

export type AudioGraphEdge = {
  id: string;
  from: string;
  to: string;
  channel: "audio" | "midi";
};

export type AstDecl = {
  kind: "state" | "buffer" | "lookup" | "midi" | "message" | "param" | "event";
  type: string;
  name: string;
  bytes: number;
  note?: string;
};

export type SourceSnippet = {
  startLine: number;
  lines: string[];
  highlightLine: number;
};

export type BuildIssue = {
  code: string;
  level: "error" | "warning";
  nodeId: string;
  src: string;
  message: string;
  why: string;
  fix: string;
  snippet: SourceSnippet;
};

export type SnapshotSlot = {
  name: string;
  bytes: number;
  preview: string;
};

export type PublishScalarType = "f32" | "f64" | "i32" | "i64" | "bool";
export type PublishBufferType = PublishScalarType | "u8";

export type PublishSlotMeta =
  | {
      kind: "state";
      name: string;
      type: PublishScalarType;
      rateFps: number;
    }
  | {
      kind: "buffer";
      name: string;
      type: PublishBufferType;
      rateFps: number;
      size: number;
    };

const NODES: AudioGraphNode[] = [
  {
    id: "arpeggiator",
    label: "arpeggiator",
    kind: "unworklet",
    audioNodeType: "AudioWorkletNode",
    status: "warning",
    errorCount: 1,
    col: 0,
    row: 0,
  },
  {
    id: "polysynth",
    label: "polysynth",
    kind: "unworklet",
    audioNodeType: "AudioWorkletNode",
    status: "errors",
    errorCount: 3,
    col: 1,
    row: 0,
  },
  {
    id: "limiter",
    label: "limiter",
    kind: "unworklet",
    audioNodeType: "AudioWorkletNode",
    status: "ok",
    errorCount: 0,
    col: 2,
    row: 0,
  },
  {
    id: "reverb",
    label: "reverb",
    kind: "unworklet",
    audioNodeType: "AudioWorkletNode",
    status: "errors",
    errorCount: 1,
    col: 3,
    row: 0,
  },
  {
    id: "master",
    label: "master gain",
    kind: "standard",
    audioNodeType: "GainNode",
    status: "ok",
    errorCount: 0,
    col: 4,
    row: 0,
  },
  {
    id: "destination",
    label: "destination",
    kind: "standard",
    audioNodeType: "AudioDestinationNode",
    status: "ok",
    errorCount: 0,
    col: 5,
    row: 0,
  },
];

const EDGES: AudioGraphEdge[] = [
  { id: "arp-poly", from: "arpeggiator", to: "polysynth", channel: "midi" },
  { id: "poly-lim", from: "polysynth", to: "limiter", channel: "audio" },
  { id: "lim-rev", from: "limiter", to: "reverb", channel: "audio" },
  { id: "rev-mas", from: "reverb", to: "master", channel: "audio" },
  { id: "mas-dst", from: "master", to: "destination", channel: "audio" },
];

const AST_BY_NODE: Record<string, AstDecl[]> = {
  polysynth: [
    { kind: "state", type: "f32", name: "voices[8].osc.phase", bytes: 32 },
    { kind: "state", type: "f32", name: "voices[8].amp", bytes: 32 },
    { kind: "state", type: "f32", name: "voices[8].env.value", bytes: 32 },
    { kind: "state", type: "u8", name: "voices[8].env.stage", bytes: 8 },
    { kind: "state", type: "u8", name: "voices[8].note", bytes: 8 },
    { kind: "state", type: "u8", name: "voices[8].gate", bytes: 8 },
    {
      kind: "state",
      type: "f32",
      name: "meterL",
      bytes: 4,
      note: "publish 30 fps",
    },
    {
      kind: "state",
      type: "f32",
      name: "meterR",
      bytes: 4,
      note: "publish 30 fps",
    },
    {
      kind: "state",
      type: "i32",
      name: "activeVoices",
      bytes: 4,
      note: "publish 15 fps",
    },
    {
      kind: "buffer",
      type: "f32",
      name: "waveform[1024]",
      bytes: 4096,
      note: "publish 30 fps",
    },
    {
      kind: "buffer",
      type: "bool",
      name: "voiceGates[8]",
      bytes: 8,
      note: "publish 60 fps",
    },
    {
      kind: "lookup",
      type: "f32",
      name: "sinTable[2048]",
      bytes: 8192,
      note: "const",
    },
    {
      kind: "midi",
      type: "u32",
      name: "keys",
      bytes: 64,
      note: "ringbuffer 16",
    },
  ],
  limiter: [
    {
      kind: "buffer",
      type: "f32",
      name: "dlyL[240]",
      bytes: 960,
      note: "lookahead 5 ms",
    },
    {
      kind: "buffer",
      type: "f32",
      name: "dlyR[240]",
      bytes: 960,
      note: "lookahead 5 ms",
    },
    { kind: "state", type: "i32", name: "dlyHead", bytes: 4 },
    { kind: "state", type: "f32", name: "env", bytes: 4 },
    {
      kind: "state",
      type: "f32",
      name: "gainReductionDb",
      bytes: 4,
      note: "publish 30 fps",
    },
    {
      kind: "state",
      type: "bool",
      name: "isLimiting",
      bytes: 4,
      note: "publish 10 fps",
    },
    { kind: "param", type: "f32", name: "ceiling", bytes: 4 },
    { kind: "param", type: "f32", name: "releaseMs", bytes: 4 },
    {
      kind: "event",
      type: "u32",
      name: "overshoot",
      bytes: 2048,
      note: "ringbuffer 256",
    },
  ],
  reverb: [
    {
      kind: "buffer",
      type: "f32",
      name: "irL[4096]",
      bytes: 16384,
      note: "snapshot persistent",
    },
    {
      kind: "buffer",
      type: "f32",
      name: "irR[4096]",
      bytes: 16384,
      note: "snapshot persistent",
    },
    { kind: "buffer", type: "f32", name: "histL[4096]", bytes: 16384 },
    { kind: "buffer", type: "f32", name: "histR[4096]", bytes: 16384 },
    { kind: "state", type: "i32", name: "histHead", bytes: 4 },
    {
      kind: "state",
      type: "f32",
      name: "wetMeter",
      bytes: 4,
      note: "publish 30 fps",
    },
    {
      kind: "buffer",
      type: "f32",
      name: "spectrum[512]",
      bytes: 2048,
      note: "publish 15 fps",
    },
    { kind: "param", type: "f32", name: "wetGain", bytes: 4 },
    { kind: "param", type: "f32", name: "dryGain", bytes: 4 },
    {
      kind: "message",
      type: "u32",
      name: "uploadIR",
      bytes: 64,
      note: "ringbuffer 16",
    },
  ],
  arpeggiator: [
    {
      kind: "state",
      type: "i32",
      name: "stepIdx",
      bytes: 4,
      note: "publish 60 fps",
    },
    {
      kind: "state",
      type: "i32",
      name: "rootNote",
      bytes: 4,
      note: "snapshot persistent",
    },
    {
      kind: "state",
      type: "i32",
      name: "samplesPerStep",
      bytes: 4,
      note: "snapshot persistent",
    },
    { kind: "state", type: "i32", name: "sampleAccum", bytes: 4 },
    { kind: "state", type: "i32", name: "lastVel", bytes: 4 },
    {
      kind: "state",
      type: "bool",
      name: "activePattern",
      bytes: 4,
      note: "publish 5 fps",
    },
    {
      kind: "state",
      type: "i32",
      name: "legacyTickCounter",
      bytes: 4,
      note: "unused",
    },
    {
      kind: "buffer",
      type: "i32",
      name: "pattern[16]",
      bytes: 64,
      note: "publish 30 fps",
    },
    {
      kind: "buffer",
      type: "u8",
      name: "lastSysex[16]",
      bytes: 16,
      note: "publish 10 fps",
    },
    {
      kind: "midi",
      type: "u32",
      name: "keys",
      bytes: 64,
      note: "ringbuffer 16",
    },
    {
      kind: "midi",
      type: "u32",
      name: "arpOut",
      bytes: 64,
      note: "ringbuffer 16",
    },
  ],
  master: [],
  destination: [],
};

const BUILD_ISSUES: BuildIssue[] = [
  {
    code: "UWK0001",
    level: "error",
    nodeId: "polysynth",
    src: "src/processors/polysynth.processor.ts:84:14",
    message:
      "Declaration `buffer.f32` called inside the process lambda — declarations must live at the top of `defineProcessor`.",
    why: "Declaration helpers (`state.*`, `buffer.*`, `lookup.*`, `midi.*`) reserve linear-memory slots at compile time and may only appear at the top of `defineProcessor((...) => { ... })`, before the returned `process` lambda. Calling them inside `process` would allocate every audio block, which is impossible in WASM linear memory.",
    fix: "Move the declaration to the top of the `defineProcessor` body, alongside the other slot declarations, and reference the returned handle from inside `process`.",
    snippet: {
      startLine: 80,
      highlightLine: 84,
      lines: [
        "export default defineProcessor(({ state, buffer }) => {",
        "  const voices = state.struct({ phase: state.f32(0), amp: state.f32(0) });",
        "",
        "  return ({ outputs }, ctx) => {",
        "    const meter = state.buffer.f32(1).named('meterPeak');",
        "    for (let i = 0; i < outputs[0].length; i++) {",
        "      outputs[0][i] = voices.phase.read(0);",
        "    }",
        "  };",
        "});",
      ],
    },
  },
  {
    code: "UWK0002",
    level: "error",
    nodeId: "reverb",
    src: "src/processors/reverb.processor.ts:21:6",
    message: "`forSample.byN` stride is dynamic — must be a compile-time constant.",
    why: "`forSample.byN(stride, ...)` is unrolled at compile time, so `stride` must be a positive integer literal that divides SAMPLES_PER_BLOCK (= 128). A dynamic value would force a runtime branch every sample and break the unrolled WASM schedule.",
    fix: "Replace the variable with one of: 1 / 2 / 4 / 8 / 16 / 32 / 64 / 128.",
    snippet: {
      startLine: 17,
      highlightLine: 21,
      lines: [
        "return ({ inputs, outputs }, ctx) => {",
        "  const stride = computeAdaptiveStride(ctx.sampleRate);",
        "",
        "  forSample.byN(stride, (i) => {",
        "    delayLineA[writeIdx.read()] = inputs[0][i];",
        "    writeIdx.update((v) => (v + 1) % delayLineA.length);",
        "  });",
        "};",
      ],
    },
  },
  {
    code: "UWK0004",
    level: "error",
    nodeId: "polysynth",
    src: "src/processors/polysynth.processor.ts:1:1",
    message: "Declaration sum (= 67.2 MB) exceeds the 64 MB memory budget.",
    why: "All `state` / `buffer` / `lookup` declarations live in a single linear-memory region inside the worklet. The compiler sums their declared sizes ahead of time. Crossing 64 MB risks contention with browser allocators and is rejected by the build.",
    fix: "Reduce buffer sizes (`lookup.f32(N)` is the biggest contributor here), or upload large content via the `message<T>` runtime channel instead of declaring it at compile time.",
    snippet: {
      startLine: 1,
      highlightLine: 3,
      lines: [
        "import { defineProcessor, lookup, state } from '@unworklet/core';",
        "",
        "const SAMPLE_TABLE_SIZE = 16_777_216; // 64 MB at f32",
        "const sampleTable = lookup.f32(SAMPLE_TABLE_SIZE);",
        "",
        "export default defineProcessor(({ state, midi }) => {",
      ],
    },
  },
  {
    code: "UWK0011",
    level: "error",
    nodeId: "polysynth",
    src: "src/processors/polysynth.processor.ts:51:18",
    message: "`emitIf(true, ...)` inside `forSample` — audio-rate emit saturates the ringbuffer.",
    why: "`emitIf(cond, fn)` queues a main-thread message when `cond` is truthy. Inside a `forSample` callback this fires up to 128 × 375 ≈ 48 000 times per second per channel, instantly overflowing the SAB ringbuffer that carries events back to the main thread.",
    fix: "Gate on a state-edge expression (e.g. `voice.gate.justRose()`), or wrap with `everyNSamples(N, ...)`, or move the emit into a MIDI handler context where it fires once per inbound event.",
    snippet: {
      startLine: 47,
      highlightLine: 51,
      lines: [
        "forSample.byN(1, (i) => {",
        "  const sample = oscBank.read(i);",
        "  outputs[0][i] = sample;",
        "",
        "  emitIf(true, () => {",
        "    debugLog.send({ tick: ctx.currentFrame, sample });",
        "  });",
        "});",
      ],
    },
  },
  {
    code: "UWK0015",
    level: "warning",
    nodeId: "arpeggiator",
    src: "src/processors/arpeggiator.processor.ts:128:6",
    message: "`state.i32(0).named('legacyTickCounter')` declared but never read.",
    why: "A named state slot is a public surface — the framework wires it into snapshot/restore, devtools, and migration anchors. Declaring one and never referencing it leaves dead bytes in every snapshot and confuses tools that traverse named slots.",
    fix: "Remove the declaration, or drop the `.named(...)` chain to keep the slot worklet-private (= no snapshot/restore exposure).",
    snippet: {
      startLine: 124,
      highlightLine: 128,
      lines: [
        "export default defineProcessor(({ state, midi }) => {",
        "  const stepIndex = state.i32(0).named('stepIndex');",
        "  const patternLen = state.i32(8).named('patternLen');",
        "  const framesSinceStep = state.u32(0).named('framesSinceStep');",
        "  const legacyTickCounter = state.i32(0).named('legacyTickCounter');",
        "",
        "  return ({ outputs }, ctx) => {",
        "    // ... stepIndex / patternLen / framesSinceStep used below ...",
      ],
    },
  },
];

export type NodeIO = {
  audioIn?: { name: string; channels: number };
  audioOut?: { name: string; channels: number };
  midiIn: string[];
  midiOut: string[];
};

const IO_BY_NODE: Record<string, NodeIO> = {
  arpeggiator: {
    audioOut: { name: "main", channels: 1 },
    midiIn: ["keys"],
    midiOut: ["arpOut"],
  },
  polysynth: {
    audioOut: { name: "main", channels: 2 },
    midiIn: ["keys"],
    midiOut: [],
  },
  limiter: {
    audioIn: { name: "main", channels: 2 },
    audioOut: { name: "main", channels: 2 },
    midiIn: [],
    midiOut: [],
  },
  reverb: {
    audioIn: { name: "main", channels: 2 },
    audioOut: { name: "main", channels: 2 },
    midiIn: [],
    midiOut: [],
  },
  master: { midiIn: [], midiOut: [] },
  destination: { midiIn: [], midiOut: [] },
};

const PUBLISH_BY_NODE: Record<string, PublishSlotMeta[]> = {
  arpeggiator: [
    { kind: "state", name: "stepIdx", type: "i32", rateFps: 60 },
    { kind: "buffer", name: "pattern", type: "i32", rateFps: 30, size: 16 },
    { kind: "state", name: "activePattern", type: "bool", rateFps: 5 },
    { kind: "buffer", name: "lastSysex", type: "u8", rateFps: 10, size: 16 },
  ],
  polysynth: [
    { kind: "state", name: "activeVoices", type: "i32", rateFps: 15 },
    { kind: "state", name: "meterL", type: "f32", rateFps: 30 },
    { kind: "state", name: "meterR", type: "f32", rateFps: 30 },
    { kind: "buffer", name: "waveform", type: "f32", rateFps: 30, size: 1024 },
    { kind: "buffer", name: "voiceGates", type: "bool", rateFps: 60, size: 8 },
  ],
  limiter: [
    { kind: "state", name: "gainReductionDb", type: "f32", rateFps: 30 },
    { kind: "state", name: "isLimiting", type: "bool", rateFps: 10 },
  ],
  reverb: [
    { kind: "state", name: "wetMeter", type: "f32", rateFps: 30 },
    { kind: "buffer", name: "spectrum", type: "f32", rateFps: 15, size: 512 },
  ],
  master: [],
  destination: [],
};

const SNAPSHOT_BY_NODE: Record<string, SnapshotSlot[]> = {
  polysynth: [
    {
      name: "voices[0..7].osc.phase",
      bytes: 32,
      preview: "[0.512, 0.713, 0.0, …]",
    },
    { name: "voices[0..7].amp", bytes: 32, preview: "[0.842, 0.0, 0.0, …]" },
    {
      name: "voices[0..7].env.value",
      bytes: 32,
      preview: "[0.713, 0.0, 0.0, …]",
    },
    { name: "voices[0..7].env.stage", bytes: 8, preview: "[1, 0, 0, 0, …]" },
    { name: "voices[0..7].note", bytes: 8, preview: "[62, 0, 0, 0, …]" },
    { name: "voices[0..7].gate", bytes: 8, preview: "[1, 0, 0, 0, …]" },
    { name: "midiIn[16]", bytes: 64, preview: "<ringbuffer head=4>" },
  ],
  limiter: [
    { name: "ceiling", bytes: 4, preview: "-0.30 dB" },
    { name: "releaseMs", bytes: 4, preview: "80 ms" },
  ],
  reverb: [
    { name: "irL[4096]", bytes: 16384, preview: "<16 KB IR float32>" },
    { name: "irR[4096]", bytes: 16384, preview: "<16 KB IR float32>" },
    { name: "wetGain", bytes: 4, preview: "0.40" },
    { name: "dryGain", bytes: 4, preview: "0.70" },
  ],
  arpeggiator: [
    { name: "rootNote", bytes: 4, preview: "60 (C4)" },
    { name: "samplesPerStep", bytes: 4, preview: "6000" },
    { name: "pattern[16]", bytes: 64, preview: "[0, 4, 7, 12, 16, 19, 24, …]" },
    { name: "midiOut[16]", bytes: 64, preview: "<ringbuffer head=2>" },
  ],
  master: [],
  destination: [],
};

const selectedId = ref<string>("polysynth");

const selectNode = (id: string): void => {
  selectedId.value = id;
};

const selectedNode = computed(() => NODES.find((n) => n.id === selectedId.value));

const issuesByNode = (id: string): BuildIssue[] => BUILD_ISSUES.filter((iss) => iss.nodeId === id);

const totalIssueCount = computed(() => BUILD_ISSUES.length);
const errorIssueCount = computed(() => BUILD_ISSUES.filter((i) => i.level === "error").length);
const warningIssueCount = computed(() => BUILD_ISSUES.filter((i) => i.level === "warning").length);

export const useMockGraph = () => ({
  nodes: NODES,
  edges: EDGES,
  buildIssues: BUILD_ISSUES,
  selectedId,
  selectedNode,
  selectNode,
  astDecls: (id: string): AstDecl[] => AST_BY_NODE[id] ?? [],
  buildIssuesByNode: issuesByNode,
  publishSlots: (id: string): PublishSlotMeta[] => PUBLISH_BY_NODE[id] ?? [],
  nodeIO: (id: string): NodeIO => IO_BY_NODE[id] ?? { midiIn: [], midiOut: [] },
  snapshotSlots: (id: string): SnapshotSlot[] => SNAPSHOT_BY_NODE[id] ?? [],
  totalIssueCount,
  errorIssueCount,
  warningIssueCount,
});
