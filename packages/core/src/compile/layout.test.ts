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
