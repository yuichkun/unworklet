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
  payloadContent: { base: totalBytes, slots: {} },
  midiRings: { base: totalBytes, slots: {} },
  sysexContent: { base: totalBytes, size: 0 },
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
