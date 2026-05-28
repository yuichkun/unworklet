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
 * `event<T>` ringbuffer slot の per-field wire size (= `02-messaging.md` §5.1)。
 *
 * u32 align within the slot (= bool は 1 byte だ が u32 word 占 有 = 4 byte)。
 * f64 / i64 = 8 byte natural size。 slot 全 体 = atSample + Σ field、 各 field
 * は declaration 順 に offset packing。
 */
const EVENT_FIELD_BYTES: Record<ScalarType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
};

/**
 * `event<T>` ringbuffer の header byte size (= `02-messaging.md` §4 + §5.1)。
 * `[head:i32, tail:i32, overflowCount:i32]` = 3 × 4 byte = 12 byte。
 */
const EVENT_HEADER_BYTES = 12;

/**
 * `event<T>` ringbuffer の atSample field byte size (= `02-messaging.md` §5.1)。
 * sample-accurate end-to-end の wire-injected field、 i32 (= 0..127) 固 定。
 */
const EVENT_ATSAMPLE_BYTES = 4;

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

/**
 * Per-event ringbuffer metadata (= `02-messaging.md` §4 header + §5.1 slot)。
 *
 * - `base`: ring 全 体 (= header + slot 列) の memory offset
 * - `capacity`: slot 数 (= `event<T>({ capacity })` の override or default 256)
 * - `slotSize`: 1 slot の byte 数 (= atSample + Σ field)
 * - `fields`: slot 内 per-field 内 訳 (= atSample を 含 む、 emit / drain で
 *   offset 引 き 用)。 field 並 び = atSample 先 頭、 残 り は 1 番 目 emit site
 *   で seal さ れ た `EventDeclAst.fields` 順
 *
 * memory map: `base` ~ `base + 12` = header `[head, tail, overflowCount]`、
 * `base + 12 + i × slotSize` = i 番 目 slot 先 頭。
 */
export type EventRingSlot = {
  base: number;
  capacity: number;
  slotSize: number;
  fields: Array<{
    name: string;
    wireType: ScalarType;
    offsetInSlot: number;
    byteSize: number;
  }>;
};

/**
 * Per-message ringbuffer metadata (= `02-messaging.md` §5.3)。
 *
 * event ring と zip pattern、 ただ し slot 内 に atSample ナ シ (= main → worklet
 * で sample-offset 概 念 ナ シ)。 fields = 1 番 目 onReceive で seal さ れ た
 * Q46 uniform-lift wire 型 順 (= 全 number → i32 4 byte / 全 boolean → bool 4 byte
 * u32 align)。 void payload (= fields = []) は slot size 0 = ring = header 12
 * の み で fire 回 数 を head - tail で 観 測。
 */
export type MessageRingSlot = {
  base: number;
  capacity: number;
  slotSize: number;
  fields: Array<{
    name: string;
    wireType: ScalarType;
    offsetInSlot: number;
    byteSize: number;
  }>;
};

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
    eventRings: { base: number; slots: Record<string, EventRingSlot> };
    messageRings: { base: number; slots: Record<string, MessageRingSlot> };
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

  // eventRings packing = publishCounters 末 尾 を base に declaration 順 で
  // per-event ring (= header 12 + capacity × slotSize) を 配 置 (= `02-messaging.md`
  // §5.1)。 slot 内 = atSample 先 頭 + 1 番 目 emit で seal さ れ た fields 順 で
  // 並 べ る = u32 align (= bool は 1 byte だ が u32 word 占 有 = 4 byte)。
  const eventRingsBase = cursor;
  const eventRingsSlots: Record<string, EventRingSlot> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "event") {
      const ringBase = cursor;
      const slotFields: EventRingSlot["fields"] = [
        { name: "atSample", wireType: "i32", offsetInSlot: 0, byteSize: EVENT_ATSAMPLE_BYTES },
      ];
      let fieldCursor = EVENT_ATSAMPLE_BYTES;
      for (const field of decl.fields) {
        const byteSize = EVENT_FIELD_BYTES[field.wireType];
        slotFields.push({
          name: field.name,
          wireType: field.wireType,
          offsetInSlot: fieldCursor,
          byteSize,
        });
        fieldCursor += byteSize;
      }
      const slotSize = fieldCursor;
      eventRingsSlots[decl.name] = {
        base: ringBase,
        capacity: decl.capacity,
        slotSize,
        fields: slotFields,
      };
      cursor += EVENT_HEADER_BYTES + decl.capacity * slotSize;
    }
  }

  // messageRings packing = eventRings 末 尾 を base に declaration 順 で
  // per-message ring (= header 12 + capacity × slotSize) を 配 置 (= `02-messaging.md`
  // §5.3)。 event ring と zip pattern だ が slot 内 atSample ナ シ + fields 順 で
  // 並 び (= Q46 uniform lift = 全 i32 / bool が 4 byte で 並 ぶ)。
  const messageRingsBase = cursor;
  const messageRingsSlots: Record<string, MessageRingSlot> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "message") {
      const ringBase = cursor;
      const slotFields: MessageRingSlot["fields"] = [];
      let fieldCursor = 0;
      for (const field of decl.fields) {
        const byteSize = EVENT_FIELD_BYTES[field.wireType];
        slotFields.push({
          name: field.name,
          wireType: field.wireType,
          offsetInSlot: fieldCursor,
          byteSize,
        });
        fieldCursor += byteSize;
      }
      const slotSize = fieldCursor;
      messageRingsSlots[decl.name] = {
        base: ringBase,
        capacity: decl.capacity,
        slotSize,
        fields: slotFields,
      };
      cursor += EVENT_HEADER_BYTES + decl.capacity * slotSize;
    }
  }

  const totalBytes = cursor;

  // sub-phase 7.7b で fill 対 象 外 の 4 region = base 全 て totalBytes (= 連 続)、
  // slots / size 0。 後 続 sub-phase で 該 当 region に slot が 追 加 さ れ た 時
  // 順 次 base を 再 計 算 す る path = layout 関 数 を 拡 張 す る だ け で
  // 既 ioScratch / states / publishShared / publishCounters / eventRings 配 置
  // に は 影 響 ナ シ (= subset → superset 規 約)。
  return {
    regions: {
      states: { base: statesBase, slots: stateSlots },
      buffers: { base: totalBytes, slots: {} },
      ioScratch: { base: ioBase, inputs, outputs, params },
      eventRings: { base: eventRingsBase, slots: eventRingsSlots },
      messageRings: { base: messageRingsBase, slots: messageRingsSlots },
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
