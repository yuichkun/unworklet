/**
 * Behavior of the linear-memory layout stage (= plan Q-C sub-region
 * 区 切 り + 各 region 内 declaration 順 auto-pack)。
 *
 * Phase 3 = `ioScratch` 1 region だ け fill、 他 9 region は 空 (= slots
 * / size 0、 base = totalBytes 連 続)。 後 続 phase で 該 当 region を
 * 順 次 fill = subset → superset = 「拡 張 path」 = inline snapshot で
 * は な く 各 fixture の 完 全 一 致 (= `toEqual`) で declare。
 */

import { expect, test } from "vite-plus/test";

import type { CapturedGraph } from "./ast.ts";
import { layout } from "./layout.ts";
import type { Layout } from "./layout.ts";

// Phase 3 で fill 対 象 外 の 9 region は 全 fixture で 同 形 = base が
// `totalBytes` で 各 fixture ご と に shape を 組 む helper。
const emptyTail = (
  totalBytes: number,
): Pick<
  Layout["regions"],
  | "states"
  | "buffers"
  | "eventRings"
  | "messageRings"
  | "payloadContent"
  | "everyNSamplesCounters"
  | "midiRings"
  | "sysexContent"
  | "publishShared"
  | "publishCounters"
  | "snapshotRegion"
> => ({
  states: { base: totalBytes, slots: {} },
  buffers: { base: totalBytes, slots: {} },
  eventRings: { base: totalBytes, slots: {} },
  messageRings: { base: totalBytes, slots: {} },
  payloadContent: { base: totalBytes, eventSlots: {}, messageSlots: {} },
  everyNSamplesCounters: { base: totalBytes, slots: {} },
  midiRings: { base: totalBytes, slots: {} },
  sysexContent: { base: totalBytes, slots: {} },
  publishShared: { base: totalBytes, slots: {} },
  publishCounters: { base: totalBytes, slots: {} },
  snapshotRegion: { base: totalBytes, size: 0 },
});

test("`layout(emptyGraph)` returns an all-zero Layout (= no declarations)", () => {
  expect(layout({ declarations: [], statements: [] })).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(0),
    },
    totalBytes: 0,
  });
});

test("`layout(monoInputOnly)` = 1 ch × 128 sample × 4 byte = 512", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioInput", name: "mono", channels: 1 }],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: { mono: 0 }, outputs: {}, params: {} },
      ...emptyTail(512),
    },
    totalBytes: 512,
  });
});

test("`layout(stereoInputOnly)` = 2 ch × 128 sample × 4 byte = 1024", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "audioInput", name: "stereo", channels: 2 }],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: { stereo: 0 }, outputs: {}, params: {} },
      ...emptyTail(1024),
    },
    totalBytes: 1024,
  });
});

test("`layout(paramOnly)` = 128 sample × 4 byte = 512", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 0,
        min: 0,
        max: 1,
        automationRate: "k-rate",
      },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: { gain: 0 } },
      ...emptyTail(512),
    },
    totalBytes: 512,
  });
});

test("`layout(twoInputs)` packs declarations in source order (= 先 declare が 低 offset)", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "first", channels: 1 },
      { kind: "audioInput", name: "second", channels: 1 },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: {
        base: 0,
        inputs: { first: 0, second: 512 },
        outputs: {},
        params: {},
      },
      ...emptyTail(1024),
    },
    totalBytes: 1024,
  });
});

test("`layout(outputPlusParam)` = audioOutput + param が ioScratch 内 共 通 cursor で packing", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioOutput", name: "main", channels: 1 },
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 1,
        min: 0,
        max: 1,
        automationRate: "k-rate",
      },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: {
        base: 0,
        inputs: {},
        outputs: { main: 0 },
        params: { gain: 512 },
      },
      ...emptyTail(1024),
    },
    totalBytes: 1024,
  });
});

test("`layout(stereoGain)` = canonical Ex 1 minus meter (= 1024 + 1024 + 512 = 2560)", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 2 },
      { kind: "audioOutput", name: "main", channels: 2 },
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 1,
        min: 0,
        max: 4,
        automationRate: "a-rate",
      },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: {
        base: 0,
        inputs: { main: 0 },
        outputs: { main: 1024 },
        params: { gain: 2048 },
      },
      ...emptyTail(2560),
    },
    totalBytes: 2560,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// states region = Phase 7 sub-phase 7.1 (= state.<type> plain factory の
// scalar slot を ioScratch 末 尾 か ら declaration 順 で packing)
// ─────────────────────────────────────────────────────────────────────────

test("`layout(stateF32Only)` = 4 byte at states region base 0", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "f32", initial: 0 }],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(4),
      states: { base: 0, slots: { x: 0 } },
    },
    totalBytes: 4,
  });
});

test("`layout(stateF64Only)` = 8 byte slot for f64", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "f64", initial: 0 }],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(8),
      states: { base: 0, slots: { x: 0 } },
    },
    totalBytes: 8,
  });
});

test("`layout(stateI32Only)` = 4 byte slot for i32", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "i32", initial: 0 }],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(4),
      states: { base: 0, slots: { x: 0 } },
    },
    totalBytes: 4,
  });
});

test("`layout(stateI64Only)` = 8 byte slot for i64", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "i64", initial: 0n }],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(8),
      states: { base: 0, slots: { x: 0 } },
    },
    totalBytes: 8,
  });
});

test("`layout(stateBoolOnly)` = 4 byte slot for bool (= 内 部 i32 表 現)", () => {
  const graph: CapturedGraph = {
    declarations: [{ kind: "state", name: "x", type: "bool", initial: false }],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(4),
      states: { base: 0, slots: { x: 0 } },
    },
    totalBytes: 4,
  });
});

test("`layout(mixedStates)` = 5 type 全 並 列 で declaration 順 packing (= 4+8+4+8+4 = 28)", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "a", type: "f32", initial: 0 },
      { kind: "state", name: "b", type: "f64", initial: 0 },
      { kind: "state", name: "c", type: "i32", initial: 0 },
      { kind: "state", name: "d", type: "i64", initial: 0n },
      { kind: "state", name: "e", type: "bool", initial: false },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(28),
      states: { base: 0, slots: { a: 0, b: 4, c: 12, d: 16, e: 24 } },
    },
    totalBytes: 28,
  });
});

test("`layout(audioInputPlusState)` = state は ioScratch 末 尾 か ら 配 置 (= base = 512)", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 1 },
      { kind: "state", name: "z1", type: "f32", initial: 0 },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: { main: 0 }, outputs: {}, params: {} },
      ...emptyTail(516),
      states: { base: 512, slots: { z1: 512 } },
    },
    totalBytes: 516,
  });
});

test("`layout(canonicalEx1Full)` = stereoIn + stereoOut + gain param + meterL/R state", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 2 },
      { kind: "audioOutput", name: "main", channels: 2 },
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 1,
        min: 0,
        max: 4,
        automationRate: "a-rate",
      },
      { kind: "state", name: "meterL", type: "f32", initial: 0 },
      { kind: "state", name: "meterR", type: "f32", initial: 0 },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: {
        base: 0,
        inputs: { main: 0 },
        outputs: { main: 1024 },
        params: { gain: 2048 },
      },
      ...emptyTail(2568),
      states: { base: 2560, slots: { meterL: 2560, meterR: 2564 } },
    },
    totalBytes: 2568,
  });
});

test("`layout(stateBeforeAudio)` = declaration 順 ナ シ で ioScratch packing 優 先 (= state base = ioScratch 末 尾)", () => {
  // state を 先 declare し て も ioScratch packing が 先 走 る (= 既 region
  // 区 切 り 規 約)、 state は 必 ず states region に packing される。
  const graph: CapturedGraph = {
    declarations: [
      { kind: "state", name: "z", type: "f32", initial: 0 },
      { kind: "audioInput", name: "main", channels: 1 },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: { main: 0 }, outputs: {}, params: {} },
      ...emptyTail(516),
      states: { base: 512, slots: { z: 512 } },
    },
    totalBytes: 516,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// publishShared / publishCounters region = Phase 7 sub-phase 7.2 (= publish
// flag を 持 つ state slot だ け が region に hit、 publishShared = 4 byte
// 単 一 word、 publishCounters = 8 byte = sample counter + version counter)
// ─────────────────────────────────────────────────────────────────────────

test("`layout(publishF32Only)` = publish flag f32 で publishShared/Counters slot 配 置", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "meterL",
        type: "f32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 30 },
      },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(16),
      states: { base: 0, slots: { meterL: 0 } },
      publishShared: { base: 4, slots: { meterL: 4 } },
      publishCounters: { base: 8, slots: { meterL: 8 } },
    },
    totalBytes: 16,
  });
});

test("`layout(publishI32 + bool)` = 全 type で 4 byte 単 一 word slot (= Q42)", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "stepIdx",
        type: "i32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 60 },
      },
      {
        kind: "state",
        name: "gate",
        type: "bool",
        initial: false,
        userNamed: true,
        publish: { rateFps: 30 },
      },
    ],
    statements: [],
  };
  // state region = 4 + 4 = 8 byte (= stepIdx 0, gate 4)
  // publishShared = 4 + 4 = 8 byte (= stepIdx 8, gate 12)
  // publishCounters = 8 + 8 = 16 byte (= stepIdx 16, gate 24)
  // total = 32 byte
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(32),
      states: { base: 0, slots: { stepIdx: 0, gate: 4 } },
      publishShared: { base: 8, slots: { stepIdx: 8, gate: 12 } },
      publishCounters: { base: 16, slots: { stepIdx: 16, gate: 24 } },
    },
    totalBytes: 32,
  });
});

test("`layout(mixedPublishAndPlain)` = publish flag ナ シ slot は publish region に hit せ ず", () => {
  const graph: CapturedGraph = {
    declarations: [
      // private z (= publish ナ シ、 synthetic name)
      { kind: "state", name: "__state_0", type: "f32", initial: 0 },
      // public meter (= publish 設 定)
      {
        kind: "state",
        name: "meterL",
        type: "f32",
        initial: 0,
        userNamed: true,
        publish: { rateFps: 30 },
      },
    ],
    statements: [],
  };
  // state region = 4 + 4 = 8 byte (= __state_0 0, meterL 4)
  // publishShared = 4 byte (= meterL の み = 4 = meterL 8)
  // publishCounters = 8 byte (= meterL 12)
  // total = 20 byte
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(20),
      states: { base: 0, slots: { __state_0: 0, meterL: 4 } },
      publishShared: { base: 8, slots: { meterL: 8 } },
      publishCounters: { base: 12, slots: { meterL: 12 } },
    },
    totalBytes: 20,
  });
});

test("`layout(snapshotOnlyNoPublish)` = snapshot 設 定 だ け で publish region は empty", () => {
  // snapshot 'persistent' を 持 つ が publish ナ シ → publishShared / Counters
  // 共 に empty (= sub-phase 11 で snapshot blob 経 由 で 取 得)
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "preset",
        type: "f32",
        initial: 0,
        userNamed: true,
        snapshot: "persistent",
      },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(4),
      states: { base: 0, slots: { preset: 0 } },
    },
    totalBytes: 4,
  });
});

test("`layout(canonicalEx1FullWithPublish)` = stereoIn + stereoOut + gain + meterL/R publish", () => {
  const graph: CapturedGraph = {
    declarations: [
      { kind: "audioInput", name: "main", channels: 2 },
      { kind: "audioOutput", name: "main", channels: 2 },
      {
        kind: "param",
        name: "gain",
        type: "f32",
        default: 1,
        min: 0,
        max: 4,
        automationRate: "a-rate",
      },
      {
        kind: "state",
        name: "meterL",
        type: "f32",
        initial: 0,
        userNamed: true,
        snapshot: "transient",
        publish: { rateFps: 30 },
      },
      {
        kind: "state",
        name: "meterR",
        type: "f32",
        initial: 0,
        userNamed: true,
        snapshot: "transient",
        publish: { rateFps: 30 },
      },
    ],
    statements: [],
  };
  // ioScratch = 1024 (= inputs) + 1024 (= outputs) + 512 (= param) = 2560
  // states = 4 + 4 = 8 (= meterL 2560, meterR 2564)
  // publishShared = 4 + 4 = 8 (= meterL 2568, meterR 2572)
  // publishCounters = 8 + 8 = 16 (= meterL 2576, meterR 2584)
  // total = 2592
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: {
        base: 0,
        inputs: { main: 0 },
        outputs: { main: 1024 },
        params: { gain: 2048 },
      },
      ...emptyTail(2592),
      states: { base: 2560, slots: { meterL: 2560, meterR: 2564 } },
      publishShared: { base: 2568, slots: { meterL: 2568, meterR: 2572 } },
      publishCounters: { base: 2576, slots: { meterL: 2576, meterR: 2584 } },
    },
    totalBytes: 2592,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// `event<T>` ringbuffer region (= `02-messaging.md` §5.1 + §4 header layout)
//
// 1 event = header (12 byte = [head, tail, overflowCount] × i32) + capacity
// 個 slot。 slot size = atSample (4 byte i32) + Σ field wire size、 全 体 を
// 4-byte align で round up (= u32 align、 §5.1 「implicit u32 alignment
// within the slot」)。
// ─────────────────────────────────────────────────────────────────────────

test("`layout(event 1 個 emit ナ シ)` = header + atSample のみ の slot 256 個", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [],
  };
  // slot size = atSample (4) = 4 byte / slot
  // ring 全 体 = header 12 + 256 × 4 = 12 + 1024 = 1036 byte
  // state / publish ナ シ → publishShared / publishCounters.base = state 末 尾 = 0
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(1036),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: {
        base: 0,
        slots: {
          peak: {
            base: 0,
            capacity: 256,
            slotSize: 4,
            fields: [{ name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 }],
          },
        },
      },
    },
    totalBytes: 1036,
  });
});

test("`layout(event 1 field f32)` = atSample (4) + level (4) = 8 byte / slot", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "peak",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [],
  };
  // ring 全 体 = header 12 + 256 × 8 = 12 + 2048 = 2060 byte
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(2060),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: {
        base: 0,
        slots: {
          peak: {
            base: 0,
            capacity: 256,
            slotSize: 8,
            fields: [
              { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "level", wireType: "f32", offsetInSlot: 4, byteSize: 4 },
            ],
          },
        },
      },
    },
    totalBytes: 2060,
  });
});

test("`layout(event 複 数 field)` = atSample + f32 + i32 + bool = 16 byte / slot", () => {
  // bool は u32 word 占 有 (= §5.1 「implicit u32 alignment」、 4 byte)。
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "evt",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [
          { name: "level", wireType: "f32" },
          { name: "channel", wireType: "i32" },
          { name: "active", wireType: "bool" },
        ],
      },
    ],
    statements: [],
  };
  // slot = atSample (4) + level (4) + channel (4) + active (4) = 16
  // ring = 12 + 256 × 16 = 4108
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(4108),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: {
        base: 0,
        slots: {
          evt: {
            base: 0,
            capacity: 256,
            slotSize: 16,
            fields: [
              { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "level", wireType: "f32", offsetInSlot: 4, byteSize: 4 },
              { name: "channel", wireType: "i32", offsetInSlot: 8, byteSize: 4 },
              { name: "active", wireType: "bool", offsetInSlot: 12, byteSize: 4 },
            ],
          },
        },
      },
    },
    totalBytes: 4108,
  });
});

test("`layout(event f64 / i64 field)` = 8 byte field を 受 容", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "wide",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [
          { name: "stamp", wireType: "i64" },
          { name: "value", wireType: "f64" },
        ],
      },
    ],
    statements: [],
  };
  // slot = atSample (4) + stamp (8) + value (8) = 20
  // ring = 12 + 256 × 20 = 5132
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(5132),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: {
        base: 0,
        slots: {
          wide: {
            base: 0,
            capacity: 256,
            slotSize: 20,
            fields: [
              { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "stamp", wireType: "i64", offsetInSlot: 4, byteSize: 8 },
              { name: "value", wireType: "f64", offsetInSlot: 12, byteSize: 8 },
            ],
          },
        },
      },
    },
    totalBytes: 5132,
  });
});

test("`layout(event capacity override)` = slot 数 = capacity option", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "small",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [],
  };
  // slot = 8 byte / 16 slot = 128 + header 12 = 140
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(140),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: {
        base: 0,
        slots: {
          small: {
            base: 0,
            capacity: 16,
            slotSize: 8,
            fields: [
              { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "level", wireType: "f32", offsetInSlot: 4, byteSize: 4 },
            ],
          },
        },
      },
    },
    totalBytes: 140,
  });
});

test("`layout(event 2 個)` = declaration 順 で 連 続 並 び", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "evt1",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
      {
        kind: "event",
        name: "evt2",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [],
  };
  // evt1 ring = 12 + 256 × 8 = 2060
  // evt2 ring = 12 + 16 × 4 = 76
  // total = 2060 + 76 = 2136
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(2136),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: {
        base: 0,
        slots: {
          evt1: {
            base: 0,
            capacity: 256,
            slotSize: 8,
            fields: [
              { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "level", wireType: "f32", offsetInSlot: 4, byteSize: 4 },
            ],
          },
          evt2: {
            base: 2060,
            capacity: 16,
            slotSize: 4,
            fields: [{ name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 }],
          },
        },
      },
    },
    totalBytes: 2136,
  });
});

test("`layout(state + event 混 在)` = states / publish 後 に eventRings", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "state",
        name: "z",
        type: "f32",
        initial: 0,
        userNamed: true,
        snapshot: "transient",
        publish: { rateFps: 30 },
      },
      {
        kind: "event",
        name: "peak",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
    ],
    statements: [],
  };
  // states (= z = 4) = 0..4
  // publishShared (= z = 4) = 4..8
  // publishCounters (= z = 8) = 8..16
  // eventRings (= peak) = 16, slot 8 × 16 + header 12 = 140 = 16..156
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(156),
      states: { base: 0, slots: { z: 0 } },
      publishShared: { base: 4, slots: { z: 4 } },
      publishCounters: { base: 8, slots: { z: 8 } },
      eventRings: {
        base: 16,
        slots: {
          peak: {
            base: 16,
            capacity: 16,
            slotSize: 8,
            fields: [
              { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "level", wireType: "f32", offsetInSlot: 4, byteSize: 4 },
            ],
          },
        },
      },
    },
    totalBytes: 156,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// `message<T>` ringbuffer region (= `02-messaging.md` §5.3)
//
// 1 message = header (12 byte = [head, tail, overflowCount] × i32) + capacity
// 個 slot。 slot = atSample ナ シ (= main → worklet で sample-offset 概念 ナ シ)
// + Q46 uniform lift (= 全 number field = i32 4 byte / 全 boolean = bool 4 byte
// u32 align)。 1 番目 onReceive で seal さ れた fields の 順 で 並ぶ。
// ─────────────────────────────────────────────────────────────────────────

test("`layout(message 1 個 fields ナ シ = void payload)` = header の み の 12 byte ring", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "message",
        name: "reset",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [],
  };
  // slot size = 0 byte (= void payload、 head - tail で fire 数 観 測)、
  // ring 全 体 = header 12 + 16 × 0 = 12 byte
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(12),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: { base: 0, slots: {} },
      messageRings: {
        base: 0,
        slots: {
          reset: {
            base: 0,
            capacity: 16,
            slotSize: 0,
            fields: [],
          },
        },
      },
    },
    totalBytes: 12,
  });
});

test("`layout(message 1 field i32)` = slot 4 byte × 256 + header 12 = 1036", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "message",
        name: "preset",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [{ name: "slot", wireType: "i32" }],
      },
    ],
    statements: [],
  };
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(1036),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: { base: 0, slots: {} },
      messageRings: {
        base: 0,
        slots: {
          preset: {
            base: 0,
            capacity: 256,
            slotSize: 4,
            fields: [{ name: "slot", wireType: "i32", offsetInSlot: 0, byteSize: 4 }],
          },
        },
      },
    },
    totalBytes: 1036,
  });
});

test("`layout(message 複 数 field)` = i32 + bool = 8 byte / slot", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "message",
        name: "ctrl",
        capacity: 256,
        payloadCapacity: undefined,
        fields: [
          { name: "slot", wireType: "i32" },
          { name: "muted", wireType: "bool" },
        ],
      },
    ],
    statements: [],
  };
  // slot = slot (4) + muted (4) = 8、 ring = 12 + 256 × 8 = 2060
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(2060),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: { base: 0, slots: {} },
      messageRings: {
        base: 0,
        slots: {
          ctrl: {
            base: 0,
            capacity: 256,
            slotSize: 8,
            fields: [
              { name: "slot", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "muted", wireType: "bool", offsetInSlot: 4, byteSize: 4 },
            ],
          },
        },
      },
    },
    totalBytes: 2060,
  });
});

test("`layout(message + event 混 在)` = eventRings 末 尾 か ら messageRings", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "event",
        name: "evt",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "level", wireType: "f32" }],
      },
      {
        kind: "message",
        name: "msg",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "slot", wireType: "i32" }],
      },
    ],
    statements: [],
  };
  // event ring = header 12 + 16 × 8 = 140
  // message ring = header 12 + 16 × 4 = 76
  // total = 140 + 76 = 216
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(216),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: {
        base: 0,
        slots: {
          evt: {
            base: 0,
            capacity: 16,
            slotSize: 8,
            fields: [
              { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: 4 },
              { name: "level", wireType: "f32", offsetInSlot: 4, byteSize: 4 },
            ],
          },
        },
      },
      messageRings: {
        base: 140,
        slots: {
          msg: {
            base: 140,
            capacity: 16,
            slotSize: 4,
            fields: [{ name: "slot", wireType: "i32", offsetInSlot: 0, byteSize: 4 }],
          },
        },
      },
    },
    totalBytes: 216,
  });
});

test("`layout(message 2 個)` = declaration 順 で 連 続 並 び", () => {
  const graph: CapturedGraph = {
    declarations: [
      {
        kind: "message",
        name: "m1",
        capacity: 16,
        payloadCapacity: undefined,
        fields: [{ name: "slot", wireType: "i32" }],
      },
      {
        kind: "message",
        name: "m2",
        capacity: 8,
        payloadCapacity: undefined,
        fields: [],
      },
    ],
    statements: [],
  };
  // m1 = 12 + 16 × 4 = 76、 m2 = 12 + 8 × 0 = 12、 total = 88
  expect(layout(graph)).toEqual({
    regions: {
      ioScratch: { base: 0, inputs: {}, outputs: {}, params: {} },
      ...emptyTail(88),
      states: { base: 0, slots: {} },
      publishShared: { base: 0, slots: {} },
      publishCounters: { base: 0, slots: {} },
      eventRings: { base: 0, slots: {} },
      messageRings: {
        base: 0,
        slots: {
          m1: {
            base: 0,
            capacity: 16,
            slotSize: 4,
            fields: [{ name: "slot", wireType: "i32", offsetInSlot: 0, byteSize: 4 }],
          },
          m2: {
            base: 76,
            capacity: 8,
            slotSize: 0,
            fields: [],
          },
        },
      },
    },
    totalBytes: 88,
  });
});
