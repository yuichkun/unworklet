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
import type { BufferElementType, ScalarType } from "../types.ts";
import type { AstNode, CapturedGraph } from "./ast.ts";

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
 * `buffer.<type>` の element byte size (= `01-dsl.md` §3.2)。 scalar 型 は state
 * と 同 size、 `u8` は 1 byte (= sysex byte buffer)。 buffer は `size × この値`
 * を 占 有。
 */
const BUFFER_ELEMENT_BYTES: Record<BufferElementType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
  u8: 1,
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
 * MIDI ringbuffer slot (`11-midi.md` §4.1): `[status:u8, data1:u8, data2:u8,
 * _pad:u8, atSample:u32]` = 8 byte。 sysex は status=0xF0 + sysex content region
 * の chunk index を data1 に 載 せ る (= §4.3、 C.4 で fill)。
 */
const MIDI_SLOT_BYTES = 8;
const MIDI_HEADER_BYTES = 12;

/**
 * typed-array field が slot 内 で 占 め る byte (= `[payloadLen:u32,
 * payloadOffset:u32]`、 §5.1/§5.2)。
 */
const PAYLOAD_SLOT_BYTES = 8;

/**
 * payloadCapacity 省 略 時 の 1 payload あ た り content default (= bytes)。 明 示
 * `payloadCapacity` で 上 書 き す る。
 */
const DEFAULT_PAYLOAD_CAPACITY = 65536;

/**
 * typed-array payload content の 同 時 保 持 枠 数 の 上 限 (= Q85)。 content region は
 * `perPayload × min(capacity, MAX_CONTENT_SLOTS)` bytes。 ring が `capacity` slot
 * (= default 256) を 持 て て も、 大 き い payload を そ の 枠 数 ぶ ん 確 保 す る と
 * 過 大 (= 64KB × 256 = 16MB) に な る た め、 同 時 に 中 身 を 保 持 す る payload を
 * 16 枠 に cap す る。 producer は 枠 を 循 環 再 利 用 = 16 枠 を 超 え て drain 前 に
 * 積 ま れ た 場 合 だ け 古 い 中 身 が 上 書 き さ れ る (= drop-oldest、trap し な い)。
 * main → worklet は 1 quantum (≈ 2.7ms) 以 内 に 17 個 以 上 の typed-array message を
 * 連 射 し な い 限 り 全 保 持。
 */
const MAX_CONTENT_SLOTS = 16;

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
    /**
     * Present when the field is a variable-length typed array (§4.3). The slot
     * carries `[payloadLen, payloadOffset]` (8 bytes); content lives in the
     * event's `payloadContent` region.
     */
    payloadElementType?: BufferElementType;
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
    /**
     * Present when the field is a variable-length typed array (§5.2). The slot
     * then carries `[payloadLen, payloadOffset]` at `offsetInSlot` (8 bytes);
     * the content lives in the `payloadContent` region for this message.
     */
    payloadElementType?: BufferElementType;
  }>;
};

/**
 * Per-port MIDI ringbuffer metadata (`11-midi.md` §4). Header layout is shared
 * with `event<T>` / `message<T>` (`[head, tail, overflowCount]`); the slot
 * encoding is the fixed 8-byte MIDI slot. `direction` records producer/consumer
 * roles (in: main produces, worklet drains; out: worklet emits, main drains).
 */
export type MidiRingSlot = {
  base: number;
  capacity: number;
  direction: "in" | "out";
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
    payloadContent: {
      base: number;
      // message<T> と event<T> は独立した名前空間 (= 同名 OK)。content region は kind 別に
      // 分離する (= eventRings / messageRings と同じ分離)。1 map を名前だけで key にすると
      // 同名 message/event が同じ region を alias して silent な cross-channel corruption を
      // 起こす (= 名前空間 kind 別の決定)。
      eventSlots: Record<string, { base: number; capacity: number; chunks: number }>;
      messageSlots: Record<string, { base: number; capacity: number; chunks: number }>;
    };
    /** everyNSamples の per-call-site counter slot (= counterId → byte offset、§9.1)。 */
    everyNSamplesCounters: { base: number; slots: Record<number, number> };
    midiRings: { base: number; slots: Record<string, MidiRingSlot> };
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
        if (field.payloadElementType !== undefined) {
          // typed-array field = slot に [payloadLen(4), payloadOffset(4)] = 8 byte
          // (= §4.3/§5.2)。 中 身 は payloadContent region。
          slotFields.push({
            name: field.name,
            wireType: field.wireType,
            offsetInSlot: fieldCursor,
            byteSize: PAYLOAD_SLOT_BYTES,
            payloadElementType: field.payloadElementType,
          });
          fieldCursor += PAYLOAD_SLOT_BYTES;
        } else {
          const byteSize = EVENT_FIELD_BYTES[field.wireType];
          slotFields.push({
            name: field.name,
            wireType: field.wireType,
            offsetInSlot: fieldCursor,
            byteSize,
          });
          fieldCursor += byteSize;
        }
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
        if (field.payloadElementType !== undefined) {
          // typed-array field = slot に [payloadLen(4), payloadOffset(4)] = 8 byte
          // (= §5.2/§5.3)。 中 身 は payloadContent region。
          slotFields.push({
            name: field.name,
            wireType: field.wireType,
            offsetInSlot: fieldCursor,
            byteSize: PAYLOAD_SLOT_BYTES,
            payloadElementType: field.payloadElementType,
          });
          fieldCursor += PAYLOAD_SLOT_BYTES;
        } else {
          const byteSize = EVENT_FIELD_BYTES[field.wireType];
          slotFields.push({
            name: field.name,
            wireType: field.wireType,
            offsetInSlot: fieldCursor,
            byteSize,
          });
          fieldCursor += byteSize;
        }
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

  // buffers packing = messageRings 末 尾 を base に declaration 順 で `size ×
  // sizeof` を allocate (= `01-dsl.md` §3.2、 u8 = 1 byte)。 worklet-private
  // scratch / delay line / wavetable region。 末 尾 配 置 = buffer ナ シ graph
  // で 既 region base 不 変 (= subset → superset 規 約)。
  const buffersBase = cursor;
  const bufferSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "buffer") {
      bufferSlots[decl.name] = cursor;
      cursor += decl.size * BUFFER_ELEMENT_BYTES[decl.type];
    }
  }

  // payloadContent packing = message<T> (main→worklet) / event<T> (worklet→main)
  // の typed-array field の 可 変 長 中 身 を 置 く region (= §5.2)。 typed-array field
  // を 持 つ declaration ご と に payloadCapacity bytes (= 省 略 時 default) を allocate。
  // 末 尾 配 置 = typed-array ナ シ graph で base 不 変。
  const payloadContentBase = cursor;
  // kind 別 map (= 同名 message/event が region を共有しない、名前空間 kind 別)。
  const payloadContentEventSlots: Record<
    string,
    { base: number; capacity: number; chunks: number }
  > = {};
  const payloadContentMessageSlots: Record<
    string,
    { base: number; capacity: number; chunks: number }
  > = {};
  for (const decl of graph.declarations) {
    if (
      (decl.kind === "message" || decl.kind === "event") &&
      decl.fields.some((f) => f.payloadElementType !== undefined)
    ) {
      const perPayload = decl.payloadCapacity ?? DEFAULT_PAYLOAD_CAPACITY;
      // content は payload を slot ご と に 別 chunk で 保 持 (= 次 の drain ま で に
      // 複 数 payload が ring に 積 ま れ て も 上 書 き さ れ な い、§5.2)。 ただ し 枠 数 は
      // MAX_CONTENT_SLOTS で cap (= 大 payload × ring capacity が 過 大 に な る の を 防 ぐ、
      // Q85)。 message も event も 同 形。 slot-indexed writer (= event emit / offline
      // inject) は `chunks` で modulo、cursor 系 (= client / worklet postMessage) は
      // region size で wrap = 同 じ 循 環 を 共 有。
      const chunks = Math.min(decl.capacity, MAX_CONTENT_SLOTS);
      const capacity = perPayload * chunks;
      const target = decl.kind === "event" ? payloadContentEventSlots : payloadContentMessageSlots;
      target[decl.name] = { base: cursor, capacity, chunks };
      cursor += capacity;
    }
  }

  // everyNSamples の per-call-site counter slot (= §9.1)。 各 counterId に i32 4 byte。
  // forSample / everyNSamples / messageOnReceive body を 再 帰 walk し て collect。 末 尾
  // 配 置 = everyNSamples ナ シ graph で totalBytes 不 変。 memory zero-init = counter 初 期 0。
  const everyNSamplesCountersBase = cursor;
  const everyNSamplesCounterSlots: Record<number, number> = {};
  const collectEveryNCounters = (nodes: readonly AstNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "everyNSamples") {
        everyNSamplesCounterSlots[node.counterId] = cursor;
        cursor += 4;
      }
      if (
        node.kind === "forSample" ||
        node.kind === "everyNSamples" ||
        node.kind === "messageOnReceive" ||
        node.kind === "midiOnEvent"
      ) {
        collectEveryNCounters(node.body);
      }
    }
  };
  collectEveryNCounters(graph.statements);

  // midiRings packing = everyNSamplesCounters 末 尾 を base に declaration 順 で
  // per-port ring (= header 12 + capacity × 8) を 配 置 (= `11-midi.md` §4)。
  // in / out port それぞれ 独 立 header + slot 列。 末 尾 配 置 = MIDI ナ シ graph で
  // base 不 変 (= subset → superset 規 約)。
  const midiRingsBase = cursor;
  const midiRingSlots: Record<string, MidiRingSlot> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "midiInput" || decl.kind === "midiOutput") {
      midiRingSlots[decl.name] = {
        base: cursor,
        capacity: decl.capacity,
        direction: decl.kind === "midiInput" ? "in" : "out",
      };
      cursor += MIDI_HEADER_BYTES + decl.capacity * MIDI_SLOT_BYTES;
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
      buffers: { base: buffersBase, slots: bufferSlots },
      ioScratch: { base: ioBase, inputs, outputs, params },
      eventRings: { base: eventRingsBase, slots: eventRingsSlots },
      messageRings: { base: messageRingsBase, slots: messageRingsSlots },
      payloadContent: {
        base: payloadContentBase,
        eventSlots: payloadContentEventSlots,
        messageSlots: payloadContentMessageSlots,
      },
      everyNSamplesCounters: {
        base: everyNSamplesCountersBase,
        slots: everyNSamplesCounterSlots,
      },
      midiRings: { base: midiRingsBase, slots: midiRingSlots },
      sysexContent: { base: totalBytes, size: 0 },
      publishShared: { base: publishSharedBase, slots: publishSharedSlots },
      publishCounters: { base: publishCountersBase, slots: publishCountersSlots },
      snapshotRegion: { base: totalBytes, size: 0 },
    },
    totalBytes,
  };
}
