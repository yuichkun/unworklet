/**
 * Linear-memory layout stage of the compile pipeline (= plan Q-C
 * sub-region 区 切 り + 各 region 内 declaration 順 auto-pack)。
 *
 * `Layout` = `03-compiler.md` §4 で 列 挙 さ れ る 10 sub-region (= states /
 * buffers / ioScratch / event ring buffers / payload content / MIDI
 * ring buffer / sysex content / publish shared / publish counters /
 * snapshot region) を 持 ち、 各 region は `totalBytes` 連 続 で base 動 的
 * 計 算 + region 内 declaration 順 packing。
 *
 * Phase 3 = `ioScratch` 1 region だ け fill (= audioInput / audioOutput
 * 各 channel × SAMPLES_PER_BLOCK × 4 byte + param 1 個 × SAMPLES_PER_BLOCK
 * × 4 byte)、 他 9 region は 空 (= slots / size 0、 base = totalBytes
 * 連 続)。 後 続 phase で 該 当 region を 順 次 fill = subset → superset
 * (= plan Q-C 答 え)。
 */

import { SAMPLES_PER_BLOCK } from "../dsl/constants.ts";
import type { CapturedGraph } from "./ast.ts";

const BYTES_PER_F32 = 4;
const PARAM_SLOT_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

export type Layout = {
  regions: {
    states: { base: number; slots: Record<string, number> };
    buffers: { base: number; slots: Record<string, number> };
    ioScratch: {
      base: number;
      inputs: Record<string, number>;
      outputs: Record<string, number>;
      params: Record<string, number>;
    };
    eventRings: { base: number; slots: Record<string, number> };
    messageRings: { base: number; slots: Record<string, number> };
    payloadContent: { base: number; slots: Record<string, number> };
    midiRings: { base: number; slots: Record<string, number> };
    sysexContent: { base: number; size: number };
    publishShared: { base: number; slots: Record<string, number> };
    publishCounters: { base: number; slots: Record<string, number> };
    snapshotRegion: { base: number; size: number };
  };
  totalBytes: number;
};

export function layout(graph: CapturedGraph): Layout {
  const inputs: Record<string, number> = {};
  const outputs: Record<string, number> = {};
  const params: Record<string, number> = {};

  const ioBase = 0;
  let cursor = ioBase;

  for (const decl of graph.declarations) {
    if (decl.kind === "audioInput") {
      inputs[decl.name] = cursor;
      cursor += decl.channels * SAMPLES_PER_BLOCK * BYTES_PER_F32;
    } else if (decl.kind === "audioOutput") {
      outputs[decl.name] = cursor;
      cursor += decl.channels * SAMPLES_PER_BLOCK * BYTES_PER_F32;
    } else {
      // decl.kind === "param"
      params[decl.name] = cursor;
      cursor += PARAM_SLOT_BYTES;
    }
  }

  const totalBytes = cursor;

  // Phase 3 で fill 対 象 外 の 9 region = base 全 て totalBytes (= 連 続)、
  // slots / size 0。 後 続 phase で 該 当 region に slot が 追 加 さ れ た 時
  // 順 次 base を 再 計 算 す る path = layout 関 数 を 拡 張 す る だ け で
  // 既 ioScratch 配 置 に は 影 響 ナ シ (= subset → superset 規 約)。
  return {
    regions: {
      states: { base: totalBytes, slots: {} },
      buffers: { base: totalBytes, slots: {} },
      ioScratch: { base: ioBase, inputs, outputs, params },
      eventRings: { base: totalBytes, slots: {} },
      messageRings: { base: totalBytes, slots: {} },
      payloadContent: { base: totalBytes, slots: {} },
      midiRings: { base: totalBytes, slots: {} },
      sysexContent: { base: totalBytes, size: 0 },
      publishShared: { base: totalBytes, slots: {} },
      publishCounters: { base: totalBytes, slots: {} },
      snapshotRegion: { base: totalBytes, size: 0 },
    },
    totalBytes,
  };
}
