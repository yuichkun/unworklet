/**
 * Linear-memory layout stage of the compile pipeline (carves out the plan Q-C
 * sub-regions and auto-packs each region in declaration order).
 *
 * A `Layout` holds the 10 sub-regions enumerated in `03-compiler.md` §4 (states /
 * buffers / ioScratch / event ring buffers / payload content / MIDI
 * ring buffer / sysex content / publish shared / publish counters /
 * snapshot region). The regions are laid out contiguously up to `totalBytes`,
 * with each base computed dynamically and the slots within a region packed in
 * declaration order.
 *
 * Phase 7 sub-phase 7.1 fills the `states` region: scalar slots for the
 * `state.<type>(initial)` plain factory, packed in declaration order by
 * per-type byte size. The states region is placed immediately after the
 * ioScratch packing, with the remaining 8 regions contiguous up to `totalBytes`
 * (filled in by later sub-phases).
 */

import { SAMPLES_PER_BLOCK } from "../dsl/constants.ts";
import type { BufferElementType, ScalarType } from "../types.ts";
import type { AstNode, CapturedGraph } from "./ast.ts";

const BYTES_PER_F32 = 4;
const PARAM_SLOT_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

/**
 * Byte size of a scalar state slot (`01-dsl.md` §3.1 + Q42).
 * f32 / i32 / bool = 4 bytes (bool uses an internal i32 representation), and
 * f64 / i64 = 8 bytes. Aligned with the SAB-publish copy path in sub-phase 7.4.
 */
const STATE_SLOT_BYTES: Record<ScalarType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
};

/**
 * Element byte size for `buffer.<type>` (`01-dsl.md` §3.2). Scalar types match
 * the state slot sizes, and `u8` is 1 byte (a sysex byte buffer). A buffer
 * occupies `size × this value`.
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
 * Per-field wire size of an `event<T>` ringbuffer slot (`02-messaging.md` §5.1).
 *
 * u32 align within the slot (bool is 1 byte but occupies a full u32 word = 4
 * bytes). f64 / i64 use their 8-byte natural size. The whole slot is
 * atSample + Σ field, with each field packed at its offset in declaration order.
 */
const EVENT_FIELD_BYTES: Record<ScalarType, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
};

/**
 * Header byte size of an `event<T>` ringbuffer (`02-messaging.md` §4 + §5.1).
 * `[head:i32, tail:i32, overflowCount:i32]` = 3 × 4 bytes = 12 bytes.
 */
const EVENT_HEADER_BYTES = 12;

/**
 * MIDI ringbuffer slot (`11-midi.md` §4.1): `[status:u8, data1:u8, data2:u8,
 * _pad:u8, atSample:u32]` = 8 bytes. For sysex, status=0xF0 and data1 carries
 * the chunk index into the sysex content region (§4.3, filled in C.4).
 */
const MIDI_SLOT_BYTES = 8;
const MIDI_HEADER_BYTES = 12;

/**
 * Per-sysex-port content region sizing (`11-midi.md` §4.3). `chunks` chunks of
 * `SYSEX_PER_CHUNK_BYTES` each (= `[length:u32, data...]`), drop-oldest cycled
 * by the slot's `chunkIdx`. 1 KiB/chunk × 16 chunks = 16 KiB per sysex port.
 */
const SYSEX_PER_CHUNK_BYTES = 1024;
const SYSEX_CHUNKS = 16;

/**
 * Bytes a typed-array field occupies within a slot (`[payloadLen:u32,
 * payloadOffset:u32]`, §5.1/§5.2).
 */
const PAYLOAD_SLOT_BYTES = 8;

/**
 * Default content bytes per payload when `payloadCapacity` is omitted.
 * Overridden by an explicit `payloadCapacity`.
 */
const DEFAULT_PAYLOAD_CAPACITY = 65536;

/**
 * Upper bound on the number of typed-array payload contents held concurrently
 * (Q85). The content region is `perPayload × min(capacity, MAX_CONTENT_SLOTS)`
 * bytes. Even though the ring can hold `capacity` slots (default 256),
 * reserving content for that many slots would be excessive for large payloads
 * (64KB × 256 = 16MB), so the number of payloads whose content is held
 * concurrently is capped at 16. The producer cycles through the slots: only
 * payloads pushed beyond the 16 slots before a drain overwrite the oldest
 * content (drop-oldest, no trap). main → worklet keeps everything as long as it
 * does not fire 17 or more typed-array messages within a single quantum
 * (≈ 2.7ms).
 */
const MAX_CONTENT_SLOTS = 16;

/**
 * Byte size of the atSample field in an `event<T>` ringbuffer
 * (`02-messaging.md` §5.1). A wire-injected field for sample-accurate
 * end-to-end delivery, fixed as i32 (0..127).
 */
const EVENT_ATSAMPLE_BYTES = 4;

/**
 * Byte size of a publishShared slot (Q42 + `02-messaging.md` §5.4).
 * The publishable types (f32 / i32 / bool) are all a single 4-byte word and can
 * be written to the SAB with Atomics.store. f64 / i64 are not publishable
 * (rejected by TS / at runtime), so they never reach this region-size
 * computation.
 */
const PUBLISH_SHARED_BYTES = 4;

/**
 * Byte size of a publishCounters slot (`04-worklet-runtime.md` §7).
 * sample counter (4-byte i32) + version counter (4-byte i32) = 8 bytes per slot.
 * In sub-phase 7.3 the per-block scheduler advances the sample counter by
 * SAMPLES_PER_BLOCK and, when it crosses the threshold, copies the value and
 * increments the version.
 */
const PUBLISH_COUNTERS_BYTES = 8;

/**
 * Per-event ringbuffer metadata (`02-messaging.md` §4 header + §5.1 slot).
 *
 * - `base`: memory offset of the whole ring (header + slot array)
 * - `capacity`: number of slots (the `event<T>({ to: 'main', capacity })` override, or default 256)
 * - `slotSize`: byte size of one slot (atSample + Σ field)
 * - `fields`: per-field breakdown within a slot (including atSample), used to
 *   resolve offsets on emit / drain. Field order is atSample first, with the
 *   rest in the `EventDeclAst.fields` order sealed at the first emit site.
 *
 * memory map: `base` ~ `base + 12` is the header `[head, tail, overflowCount]`,
 * and `base + 12 + i × slotSize` is the start of the i-th slot.
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
 * Per-message ringbuffer metadata (`02-messaging.md` §5.3).
 *
 * Mirrors the event ring, except there is no atSample in the slot (main →
 * worklet has no notion of a sample offset). fields are in the Q46 uniform-lift
 * wire-type order sealed at the first onReceive (all number → i32 4 bytes / all
 * boolean → bool 4 bytes, u32 align). A void payload (fields = []) has slot size
 * 0, so the ring is just the 12-byte header and the fire count is observed via
 * head - tail.
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
    buffers: { base: number; slots: Record<string, number>; lengths: Record<string, number> };
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
      // message<T> and event<T> have independent namespaces (the same name is OK).
      // The content region is therefore separated by kind (the same split as
      // eventRings / messageRings). Keying a single map by name alone would let a
      // same-named message/event alias the same region, causing silent
      // cross-channel corruption — hence the decision to split by namespace kind.
      eventSlots: Record<string, { base: number; capacity: number; chunks: number }>;
      messageSlots: Record<string, { base: number; capacity: number; chunks: number }>;
    };
    /** Per-call-site counter slots for everyNSamples (counterId → byte offset, §9.1). */
    everyNSamplesCounters: { base: number; slots: Record<number, number> };
    /**
     * Per-declaration i32 slots for `noiseSource(...)` PRNG state (name → byte
     * offset). One 4-byte slot per declaration. Init to the effective seed by
     * an active data segment at instantiation. Absent (not just empty) when
     * the graph declares no noise sources — that keeps the layout JSON /
     * schemaHash byte-identical for every pre-noise processor.
     */
    noiseSources?: { base: number; slots: Record<string, number> };
    midiRings: { base: number; slots: Record<string, MidiRingSlot> };
    // Per-sysex-port content region (`11-midi.md` §4.3): `chunks` chunks of
    // `perChunk` bytes, each `[length:u32, data bytes]`. The 8-byte ring slot
    // carries `[0xF0, chunkIdx, _pad, _pad, atSample]`; `chunkIdx` indexes here.
    sysexContent: {
      base: number;
      slots: Record<string, { base: number; perChunk: number; chunks: number }>;
    };
    publishShared: { base: number; slots: Record<string, number> };
    publishCounters: { base: number; slots: Record<string, number> };
    snapshotRegion: { base: number; size: number };
  };
  totalBytes: number;
};

/**
 * Round a byte offset up to the next 4-byte boundary. A `u8` buffer (1
 * byte/element) or an odd `payloadCapacity` can leave the packing cursor on a
 * non-4-multiple offset; an i32-viewed region placed after it must realign its
 * base first, since `new Int32Array(memory.buffer, base, 3)` requires a
 * 4-aligned byteOffset (a non-aligned base throws RangeError at bind time).
 *
 * Uses float arithmetic, not `& ~3`: a packing cursor can exceed the signed
 * 32-bit range (the memory-budget ceiling is 4 GiB), and a 32-bit bitwise op
 * would wrap such an offset and silently corrupt `totalBytes`.
 */
const align4 = (offset: number): number => Math.ceil(offset / 4) * 4;

export function layout(graph: CapturedGraph): Layout {
  const inputs: Record<string, number> = {};
  const outputs: Record<string, number> = {};
  const params: Record<string, number> = {};

  const ioBase = 0;
  let cursor = ioBase;

  // ioScratch packing: lay out audioInput / audioOutput / param in declaration
  // order. state is skipped here and packed into the states region later.
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

  // states packing: based at the end of ioScratch, allocate per-type byte size
  // in declaration order (Q42 + aligned with the sub-phase 7.4 SAB publish path).
  const statesBase = cursor;
  const stateSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "state") {
      stateSlots[decl.name] = cursor;
      cursor += STATE_SLOT_BYTES[decl.type];
    }
  }

  // publishShared packing: based at the end of states, allocate only the state
  // slots that carry a publish flag, in declaration order (sub-phase 7.2, every
  // type a single 4-byte word = Q42). State slots without a publish flag do not
  // land here.
  const publishSharedBase = cursor;
  const publishSharedSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "state" && decl.publish !== undefined) {
      publishSharedSlots[decl.name] = cursor;
      cursor += PUBLISH_SHARED_BYTES;
    }
  }

  // publishCounters packing: based at the end of publishShared, in the same
  // order, 8 bytes per slot (sample counter + version counter). The publish-flag
  // set matches publishShared, so the same declaration order keeps the packing
  // aligned.
  const publishCountersBase = cursor;
  const publishCountersSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "state" && decl.publish !== undefined) {
      publishCountersSlots[decl.name] = cursor;
      cursor += PUBLISH_COUNTERS_BYTES;
    }
  }

  // eventRings packing: based at the end of publishCounters, place a per-event
  // ring (header 12 + capacity × slotSize) in declaration order
  // (`02-messaging.md` §5.1). Within a slot, atSample comes first, followed by
  // the fields in the order sealed at the first emit, with u32 align (bool is
  // 1 byte but occupies a full u32 word = 4 bytes).
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
          // typed-array field: the slot holds [payloadLen(4), payloadOffset(4)]
          // = 8 bytes (§4.3/§5.2). The content lives in the payloadContent region.
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

  // messageRings packing: based at the end of eventRings, place a per-message
  // ring (header 12 + capacity × slotSize) in declaration order
  // (`02-messaging.md` §5.3). Mirrors the event ring but with no atSample in the
  // slot, fields in field order (Q46 uniform lift = all i32 / bool laid out as
  // 4 bytes).
  const messageRingsBase = cursor;
  const messageRingsSlots: Record<string, MessageRingSlot> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "message") {
      const ringBase = cursor;
      const slotFields: MessageRingSlot["fields"] = [];
      let fieldCursor = 0;
      for (const field of decl.fields) {
        if (field.payloadElementType !== undefined) {
          // typed-array field: the slot holds [payloadLen(4), payloadOffset(4)]
          // = 8 bytes (§5.2/§5.3). The content lives in the payloadContent region.
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

  // buffers packing: based at the end of messageRings, allocate `size × sizeof`
  // in declaration order (`01-dsl.md` §3.2, u8 = 1 byte). A worklet-private
  // scratch / delay-line / wavetable region. Placing it at the tail keeps the
  // existing region bases unchanged for a graph with no buffers (the subset →
  // superset rule).
  const buffersBase = cursor;
  const bufferSlots: Record<string, number> = {};
  // Element count per buffer — used by emit to clamp a user `buffer[i]` index
  // into range (an out-of-range access must saturate, never trap or corrupt an
  // adjacent region).
  const bufferLengths: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "buffer") {
      bufferSlots[decl.name] = cursor;
      bufferLengths[decl.name] = decl.size;
      cursor += decl.size * BUFFER_ELEMENT_BYTES[decl.type];
    }
  }

  // payloadContent packing: the region holding the variable-length content of
  // typed-array fields for message<T> (main→worklet) / event<T> (worklet→main)
  // (§5.2). For each declaration with a typed-array field, allocate
  // payloadCapacity bytes (the default when omitted). Placing it at the tail
  // keeps the bases unchanged for a graph with no typed arrays.
  const payloadContentBase = cursor;
  // Maps split by kind (a same-named message/event does not share a region;
  // separated by namespace kind).
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
      // Round the per-chunk capacity up to 4 bytes so every chunk base stays
      // 4-aligned: the main side builds a `Float32Array` view at
      // contentOffset + chunkIdx * perPayload, which throws RangeError on a
      // misaligned offset (a custom payloadCapacity need not be a multiple of 4).
      const perPayload = align4(decl.payloadCapacity ?? DEFAULT_PAYLOAD_CAPACITY);
      // The content keeps each payload in its own chunk, so multiple payloads
      // piling up in the ring before the next drain are not overwritten (§5.2).
      // The number of slots is capped at MAX_CONTENT_SLOTS to keep
      // large-payload × ring-capacity from growing excessive (Q85). message and
      // event share the same shape. Slot-indexed writers (event emit / offline
      // inject) take modulo `chunks`, while cursor-based writers (client /
      // worklet postMessage) wrap at the region size — both share the same cycle.
      const chunks = Math.min(decl.capacity, MAX_CONTENT_SLOTS);
      const capacity = perPayload * chunks;
      const target = decl.kind === "event" ? payloadContentEventSlots : payloadContentMessageSlots;
      target[decl.name] = { base: cursor, capacity, chunks };
      cursor += capacity;
    }
  }

  // Per-call-site counter slots for everyNSamples (§9.1): an i32 4 bytes per
  // counterId. Collected by recursively walking forSample / everyNSamples /
  // messageOnReceive bodies. Placing it at the tail keeps totalBytes unchanged
  // for a graph with no everyNSamples. Zero-initialized memory means counters
  // start at 0.
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

  // Per-declaration i32 slots for noiseSource (§2 stateful sources): 4 bytes
  // per declaration, initialized to the effective seed via an active data
  // segment in emit. Placed at the tail so totalBytes is unchanged for graphs
  // with no noiseSource. Named by the synthetic key `__noise_<idx>` assigned
  // at declaration time.
  const noiseSourcesBase = cursor;
  const noiseSourceSlots: Record<string, number> = {};
  for (const decl of graph.declarations) {
    if (decl.kind === "noiseSource") {
      noiseSourceSlots[decl.name] = cursor;
      cursor += 4;
    }
  }

  // midiRings packing: based at the end of everyNSamplesCounters, place a
  // per-port ring (header 12 + capacity × 8) in declaration order
  // (`11-midi.md` §4). Each in / out port gets its own header + slot array.
  // Placing it at the tail keeps the bases unchanged for a graph with no MIDI
  // (the subset → superset rule). Since the header is viewed as i32, round the
  // base up to 4 in case a preceding u8 buffer / payloadContent left the cursor
  // off the 4-byte alignment (prevents the `new Int32Array` bind RangeError =
  // crash).
  cursor = align4(cursor);
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

  // sysexContent packing: based at the end of midiRings, place a content region
  // (chunks × perChunk) for each port that uses sysex (`11-midi.md` §4.3). Sysex
  // usage is determined by whether the graph statements contain a sysex
  // midiOnEvent / midiEmitIf for that port.
  const sysexContentBase = cursor;
  const sysexContentSlots: Record<string, { base: number; perChunk: number; chunks: number }> = {};
  const sysexPorts = new Set<string>();
  const scanSysex = (nodes: readonly AstNode[]): void => {
    for (const node of nodes) {
      if (
        (node.kind === "midiOnEvent" || node.kind === "midiEmitIf") &&
        node.eventType === "sysex"
      ) {
        sysexPorts.add(node.port);
      }
      if (
        node.kind === "forSample" ||
        node.kind === "everyNSamples" ||
        node.kind === "messageOnReceive" ||
        node.kind === "midiOnEvent"
      ) {
        scanSysex(node.body);
      }
    }
  };
  scanSysex(graph.statements);
  for (const decl of graph.declarations) {
    if ((decl.kind === "midiInput" || decl.kind === "midiOutput") && sysexPorts.has(decl.name)) {
      sysexContentSlots[decl.name] = {
        base: cursor,
        perChunk: SYSEX_PER_CHUNK_BYTES,
        chunks: SYSEX_CHUNKS,
      };
      cursor += SYSEX_PER_CHUNK_BYTES * SYSEX_CHUNKS;
    }
  }

  const totalBytes = cursor;

  // The 4 regions not filled in sub-phase 7.7b all have base = totalBytes
  // (contiguous), with empty slots / size 0. When a later sub-phase adds slots
  // to one of those regions, recomputing the bases in turn is just an extension
  // of the layout function and does not affect the existing
  // ioScratch / states / publishShared / publishCounters / eventRings placement
  // (the subset → superset rule).
  return {
    regions: {
      states: { base: statesBase, slots: stateSlots },
      buffers: { base: buffersBase, slots: bufferSlots, lengths: bufferLengths },
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
      // Only include `noiseSources` when the graph declares at least one — an
      // absent field is JSON-serialization-equivalent to the pre-noise layout,
      // so every existing processor's schemaHash / wasmSha stays byte-identical.
      ...(Object.keys(noiseSourceSlots).length > 0
        ? { noiseSources: { base: noiseSourcesBase, slots: noiseSourceSlots } }
        : {}),
      midiRings: { base: midiRingsBase, slots: midiRingSlots },
      sysexContent: { base: sysexContentBase, slots: sysexContentSlots },
      publishShared: { base: publishSharedBase, slots: publishSharedSlots },
      publishCounters: { base: publishCountersBase, slots: publishCountersSlots },
      snapshotRegion: { base: totalBytes, size: 0 },
    },
    totalBytes,
  };
}
