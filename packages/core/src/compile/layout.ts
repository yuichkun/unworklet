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
 * Phase 7 sub-phase 7.1 で `states` region を fill (= `state.<type>(initial)`
 * plain factory の scalar slot、 type 別 byte size で declaration 順
 * packing)。 ioScratch packing の 直 後 に states region を 配 置 し、
 * 残 り 8 region は `totalBytes` 連 続 (= 後 続 sub-phase で 順 次 fill)。
 */

import { SAMPLES_PER_BLOCK } from "../dsl/constants.ts";
import type { ScalarType } from "../types.ts";
import type { CapturedGraph } from "./ast.ts";

const BYTES_PER_F32 = 4;
const PARAM_SLOT_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

/**
 * scalar state slot の byte size (= `01-dsl.md` §3.1 + Q42)。
 * f32 / i32 / bool = 4 byte (= bool は 内 部 i32 表 現)、 f64 / i64 = 8 byte。
 * sub-phase 7.4 で SAB publish へ copy す る path と zip。
 */
const STATE_SLOT_BYTES: Record<ScalarType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
};

/**
 * publishShared slot の byte size (= Q42 + `02-messaging.md` §5.4)。
 * publish 対 応 type (= f32 / i32 / bool) は 全 て 4 byte 単 一 word で SAB に
 * Atomics.store 可 能。 f64 / i64 は publish 不 可 (= TS / runtime で reject 済)、
 * region size 計 算 で hit し な い。
 */
const PUBLISH_SHARED_BYTES = 4;

/**
 * publishCounters slot の byte size (= `04-worklet-runtime.md` §7)。
 * sample counter (= 4 byte i32) + version counter (= 4 byte i32) = 8 byte per slot。
 * sub-phase 7.3 で per-block scheduler が sample counter を SAMPLES_PER_BLOCK
 * 加 算 + threshold 越 え で copy + version increment。
 */
const PUBLISH_COUNTERS_BYTES = 8;

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

  // ioScratch packing = audioInput / audioOutput / param を declaration
  // 順 に 並 べ る。 state は こ こ で skip し て 後 段 で states region に packing。
  for (const decl of graph.declarations) {
    if (decl.kind === "audioInput") {
      inputs[decl.name] = cursor;
      cursor += decl.channels * SAMPLES_PER_BLOCK * BYTES_PER_F32;
    } else if (decl.kind === "audioOutput") {
      outputs[decl.name] = cursor;
      cursor += decl.channels * SAMPLES_PER_BLOCK * BYTES_PER_F32;
    } else if (decl.kind === "param") {
      params[decl.name] = cursor;
      cursor += PARAM_SLOT_BYTES;
    }
  }

  // states packing = ioScratch 末 尾 を base に declaration 順 で type 別
  // byte size を allocate (= Q42 + sub-phase 7.4 SAB publish path と zip)。
  const statesBase = cursor;
  const stateSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "state") {
      stateSlots[decl.name] = cursor;
      cursor += STATE_SLOT_BYTES[decl.type];
    }
  }

  // publishShared packing = states 末 尾 を base に publish flag を 持 つ
  // state slot だ け を declaration 順 で allocate (= sub-phase 7.2、 全 type で
  // 4 byte 単 一 word = Q42)。 publish flag な い state slot は ここ に hit せ ず。
  const publishSharedBase = cursor;
  const publishSharedSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "state" && decl.publish !== undefined) {
      publishSharedSlots[decl.name] = cursor;
      cursor += PUBLISH_SHARED_BYTES;
    }
  }

  // publishCounters packing = publishShared 末 尾 を base に 同 順 で 8 byte
  // per slot (= sample counter + version counter)。 publishShared と publish
  // flag set が 一 致 = 同 declaration 順 で packing 一 致。
  const publishCountersBase = cursor;
  const publishCountersSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "state" && decl.publish !== undefined) {
      publishCountersSlots[decl.name] = cursor;
      cursor += PUBLISH_COUNTERS_BYTES;
    }
  }

  const totalBytes = cursor;

  // sub-phase 7.2 で fill 対 象 外 の 6 region = base 全 て totalBytes (= 連 続)、
  // slots / size 0。 後 続 sub-phase で 該 当 region に slot が 追 加 さ れ た 時
  // 順 次 base を 再 計 算 す る path = layout 関 数 を 拡 張 す る だ け で
  // 既 ioScratch / states / publishShared / publishCounters 配 置 に は 影 響
  // ナ シ (= subset → superset 規 約)。
  return {
    regions: {
      states: { base: statesBase, slots: stateSlots },
      buffers: { base: totalBytes, slots: {} },
      ioScratch: { base: ioBase, inputs, outputs, params },
      eventRings: { base: totalBytes, slots: {} },
      messageRings: { base: totalBytes, slots: {} },
      payloadContent: { base: totalBytes, slots: {} },
      midiRings: { base: totalBytes, slots: {} },
      sysexContent: { base: totalBytes, size: 0 },
      publishShared: { base: publishSharedBase, slots: publishSharedSlots },
      publishCounters: { base: publishCountersBase, slots: publishCountersSlots },
      snapshotRegion: { base: totalBytes, size: 0 },
    },
    totalBytes,
  };
}
