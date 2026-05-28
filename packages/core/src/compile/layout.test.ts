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
