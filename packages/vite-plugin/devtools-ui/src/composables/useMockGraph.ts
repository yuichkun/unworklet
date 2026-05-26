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
  kind: "state" | "buffer" | "lookup" | "midi" | "message";
  type: string;
  name: string;
  bytes: number;
  note?: string;
};

export type SourceSnippet = {
  /** 1-based file line number of the first entry in `lines`. */
  startLine: number;
  lines: string[];
  /** 1-based file line number to highlight (= the offending line). */
  highlightLine: number;
};

export type BuildIssue = {
  code: string;
  level: "error" | "warning";
  nodeId: string;
  src: string;
  /** Short single-line headline shown in the list row. */
  message: string;
  /** Full explanation shown in the detail modal. */
  why: string;
  fix: string;
  snippet: SourceSnippet;
};

export type StateSlot = {
  name: string;
  kind: "state" | "buffer";
  type: string;
  preview: string;
};

export type SnapshotSlot = {
  name: string;
  bytes: number;
  preview: string;
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
    id: "reverb",
    label: "reverb",
    kind: "unworklet",
    audioNodeType: "AudioWorkletNode",
    status: "errors",
    errorCount: 1,
    col: 2,
    row: 0,
  },
  {
    id: "master",
    label: "master gain",
    kind: "standard",
    audioNodeType: "GainNode",
    status: "ok",
    errorCount: 0,
    col: 3,
    row: 0,
  },
  {
    id: "destination",
    label: "destination",
    kind: "standard",
    audioNodeType: "AudioDestinationNode",
    status: "ok",
    errorCount: 0,
    col: 4,
    row: 0,
  },
];

const EDGES: AudioGraphEdge[] = [
  { id: "arp-poly", from: "arpeggiator", to: "polysynth", channel: "midi" },
  { id: "poly-rev", from: "polysynth", to: "reverb", channel: "audio" },
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
    { kind: "buffer", type: "f32", name: "meterPeak", bytes: 4, note: "publish" },
    { kind: "lookup", type: "f32", name: "sinTable[2048]", bytes: 8192, note: "const" },
    { kind: "midi", type: "u32", name: "midiIn", bytes: 64, note: "ringbuffer 16" },
  ],
  reverb: [
    { kind: "state", type: "f32", name: "delayLineA[4800]", bytes: 19200 },
    { kind: "state", type: "f32", name: "delayLineB[2700]", bytes: 10800 },
    { kind: "state", type: "u32", name: "writeIdx", bytes: 4 },
    { kind: "buffer", type: "f32", name: "meterRms", bytes: 4, note: "publish" },
  ],
  arpeggiator: [
    { kind: "state", type: "i32", name: "stepIndex", bytes: 4 },
    { kind: "state", type: "i32", name: "patternLen", bytes: 4 },
    { kind: "state", type: "u32", name: "framesSinceStep", bytes: 4 },
    { kind: "state", type: "i32", name: "legacyTickCounter", bytes: 4, note: "unused" },
    { kind: "midi", type: "u32", name: "midiOut", bytes: 64, note: "ringbuffer 16" },
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
        "    const meter = buffer.f32(1).named('meterPeak');",
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
        "import { defineProcessor, lookup, state, buffer } from '@unworklet/core';",
        "",
        "const SAMPLE_TABLE_SIZE = 16_777_216; // 64 MB at f32",
        "const sampleTable = lookup.f32(SAMPLE_TABLE_SIZE);",
        "",
        "export default defineProcessor(({ state, buffer, midi }) => {",
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

const STATE_BY_NODE: Record<string, StateSlot[]> = {
  polysynth: [
    { name: "voices[0].osc.phase", kind: "state", type: "f32", preview: "0.512" },
    { name: "voices[0].amp", kind: "state", type: "f32", preview: "0.842" },
    { name: "voices[0].env.value", kind: "state", type: "f32", preview: "0.713" },
    { name: "voices[0].env.stage", kind: "state", type: "u8", preview: "1 (release)" },
    { name: "voices[0].note", kind: "state", type: "u8", preview: "62 (D4)" },
    { name: "voices[0].gate", kind: "state", type: "u8", preview: "1" },
    { name: "meterPeak", kind: "buffer", type: "f32", preview: "0.81" },
  ],
  reverb: [
    { name: "writeIdx", kind: "state", type: "u32", preview: "13452" },
    { name: "meterRms", kind: "buffer", type: "f32", preview: "0.42" },
  ],
  arpeggiator: [
    { name: "stepIndex", kind: "state", type: "i32", preview: "3" },
    { name: "patternLen", kind: "state", type: "i32", preview: "8" },
    { name: "framesSinceStep", kind: "state", type: "u32", preview: "2304" },
  ],
  master: [],
  destination: [],
};

const SNAPSHOT_BY_NODE: Record<string, SnapshotSlot[]> = {
  polysynth: [
    { name: "voices[0..7].osc.phase", bytes: 32, preview: "[0.512, 0.713, 0.0, …]" },
    { name: "voices[0..7].amp", bytes: 32, preview: "[0.842, 0.0, 0.0, …]" },
    { name: "voices[0..7].env.value", bytes: 32, preview: "[0.713, 0.0, 0.0, …]" },
    { name: "voices[0..7].env.stage", bytes: 8, preview: "[1, 0, 0, 0, …]" },
    { name: "voices[0..7].note", bytes: 8, preview: "[62, 0, 0, 0, …]" },
    { name: "voices[0..7].gate", bytes: 8, preview: "[1, 0, 0, 0, …]" },
    { name: "meterPeak", bytes: 4, preview: "0.81" },
    { name: "midiIn[16]", bytes: 64, preview: "<ringbuffer head=4>" },
  ],
  reverb: [
    { name: "delayLineA[4800]", bytes: 19200, preview: "<19.2 KB float32>" },
    { name: "delayLineB[2700]", bytes: 10800, preview: "<10.8 KB float32>" },
    { name: "writeIdx", bytes: 4, preview: "13452" },
    { name: "meterRms", bytes: 4, preview: "0.42" },
  ],
  arpeggiator: [
    { name: "stepIndex", bytes: 4, preview: "3" },
    { name: "patternLen", bytes: 4, preview: "8" },
    { name: "framesSinceStep", bytes: 4, preview: "2304" },
    { name: "legacyTickCounter", bytes: 4, preview: "0" },
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
  stateSlots: (id: string): StateSlot[] => STATE_BY_NODE[id] ?? [],
  snapshotSlots: (id: string): SnapshotSlot[] => SNAPSHOT_BY_NODE[id] ?? [],
  totalIssueCount,
  errorIssueCount,
  warningIssueCount,
});
