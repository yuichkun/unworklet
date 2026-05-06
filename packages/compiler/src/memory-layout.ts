// Plans the WASM linear memory layout for a captured graph.
//
// Layout (all offsets in bytes):
//
//   [0, S)         — state slots (each slot 8 bytes regardless of type, max(f64,i64))
//   [S, S+B)       — buffers (each buffer aligned to 16 bytes for SIMD)
//   [S+B, S+B+I)   — I/O scratch:
//                       input channels (numInputs × maxChannels × renderQuantum × 4)
//                       output channels (same)
//                       param values   (numParams × max(1, renderQuantum) × 4)
//   [S+B+I, ...]   — event/message ring buffers (per declared event/message)
//                    each ring: [head:i32][tail:i32][overflowCount:i32][slots × slotSize]
//                    slot layout depends on event type schema
//
// All offsets are 16-byte aligned (SIMD-safe).

import type { CapturedGraph, ScalarType } from "./ast.js";

const ALIGN = 16;
function align(n: number): number {
  return (n + ALIGN - 1) & ~(ALIGN - 1);
}

function sizeOf(t: ScalarType): number {
  switch (t) {
    case "f32":
      return 4;
    case "f64":
      return 8;
    case "i32":
      return 4;
    case "i64":
      return 8;
    case "bool":
      return 4; // i32-encoded
  }
}

export type StateSlotLayout = {
  slotId: number;
  type: ScalarType;
  offset: number;
};
export type BufferLayout = {
  bufferId: number;
  type: ScalarType;
  size: number;
  offset: number;
  byteSize: number;
};
export type AudioInputLayout = {
  inputId: number;
  channels: number;
  // Each channel's data starts at: offset + channel × renderQuantum × 4
  offset: number;
  channelStride: number;
};
export type AudioOutputLayout = {
  outputId: number;
  channels: number;
  offset: number;
  channelStride: number;
};
export type ParamLayout = {
  paramId: number;
  automationRate: "a-rate" | "k-rate";
  offset: number;
  // For a-rate: renderQuantum × 4 bytes. For k-rate: 4 bytes (single value
  // padded to alignment).
  byteSize: number;
};

export type EventLayout = {
  eventId: number;
  capacity: number;
  // Header: [head u32][tail u32][overflow u32][_pad u32] = 16 bytes
  headerOffset: number;
  slotsOffset: number;
  slotSize: number; // bytes per slot
  // Map field name -> offset within slot (atSample is at offset 0)
  fieldOffsets: Record<string, { offset: number; type: ScalarType }>;
  totalBytes: number;
};
export type MessageLayout = {
  messageId: number;
  capacity: number;
  headerOffset: number;
  slotsOffset: number;
  slotSize: number;
  fieldOffsets: Record<string, { offset: number; type: ScalarType }>;
  // Typed-array (variable-length) payload fields. Each gets a per-slot
  // content area inside the message's content buffer. The slot fields
  // record `<name>__off` (i32) and `<name>__len` (i32) offsets relative
  // to the slot itself; the content lives at `payloadBufferOffset +
  // slotIdx * payloadStridePerSlot + fieldOffsetWithinPayload`.
  payloadFields: Array<{
    name: string;
    elemType: "f32" | "i32" | "u8";
    maxLength: number;
    bytesPerElem: number;
    fieldOffsetWithinPayload: number;
    fieldBytes: number;
    // Position of the per-slot offset/length scalars inside the slot.
    slotOffsetField: number;
    slotLengthField: number;
  }>;
  payloadStridePerSlot: number; // bytes per slot in the content buffer
  payloadBufferOffset: number;
  payloadBufferBytes: number;
  totalBytes: number;
};
export type MidiLayout = {
  midiId: number;
  capacity: number;
  headerOffset: number;
  slotsOffset: number;
  // MIDI fixed slot: [status u8][data1 u8][data2 u8][_pad u8][atSample u32] = 8 bytes
  slotSize: 8;
  totalBytes: number;
};

export type MemoryLayout = {
  stateRegion: { offset: number; size: number; slots: StateSlotLayout[] };
  bufferRegion: { offset: number; size: number; buffers: BufferLayout[] };
  audioInputs: { offset: number; size: number; inputs: AudioInputLayout[] };
  audioOutputs: { offset: number; size: number; outputs: AudioOutputLayout[] };
  params: { offset: number; size: number; layouts: ParamLayout[] };
  events: { offset: number; size: number; layouts: EventLayout[] };
  messages: { offset: number; size: number; layouts: MessageLayout[] };
  midiInputs: { offset: number; size: number; layouts: MidiLayout[] };
  midiOutputs: { offset: number; size: number; layouts: MidiLayout[] };
  totalBytes: number;
  initialPages: number; // 64 KiB pages
  renderQuantum: number;
  maxInputChannels: number;
  maxOutputChannels: number;
};

export type LayoutOptions = {
  renderQuantum: number;
  maxInputChannels?: number; // default 2
  maxOutputChannels?: number; // default 2
};

export function planLayout(g: CapturedGraph, opts: LayoutOptions): MemoryLayout {
  const renderQuantum = opts.renderQuantum;
  const maxInputCh = opts.maxInputChannels ?? Math.max(2, ...g.declarations.audioInputs.map((a) => a.channels));
  const maxOutputCh = opts.maxOutputChannels ?? Math.max(2, ...g.declarations.audioOutputs.map((a) => a.channels));

  let cursor = 0;

  // State region: each slot 8 bytes (max scalar size), 16-byte aligned per slot
  // is overkill; use 8-byte slots packed.
  const stateStart = align(cursor);
  cursor = stateStart;
  const stateSlots: StateSlotLayout[] = [];
  for (const s of g.declarations.states) {
    stateSlots.push({ slotId: s.id, type: s.type, offset: cursor });
    cursor += 8;
  }
  cursor = align(cursor);
  const stateSize = cursor - stateStart;

  // Buffer region: each buffer 16-byte aligned
  const bufferStart = cursor;
  const buffers: BufferLayout[] = [];
  for (const b of g.declarations.buffers) {
    cursor = align(cursor);
    const byteSize = b.size * sizeOf(b.type);
    buffers.push({
      bufferId: b.id,
      type: b.type,
      size: b.size,
      offset: cursor,
      byteSize,
    });
    cursor += byteSize;
  }
  cursor = align(cursor);
  const bufferSize = cursor - bufferStart;

  // Audio input scratch
  const audioInStart = cursor;
  const audioInputs: AudioInputLayout[] = [];
  for (const ai of g.declarations.audioInputs) {
    cursor = align(cursor);
    const stride = renderQuantum * 4;
    audioInputs.push({
      inputId: ai.id,
      channels: ai.channels,
      offset: cursor,
      channelStride: stride,
    });
    cursor += ai.channels * stride;
  }
  cursor = align(cursor);
  const audioInSize = cursor - audioInStart;

  // Audio output scratch
  const audioOutStart = cursor;
  const audioOutputs: AudioOutputLayout[] = [];
  for (const ao of g.declarations.audioOutputs) {
    cursor = align(cursor);
    const stride = renderQuantum * 4;
    audioOutputs.push({
      outputId: ao.id,
      channels: ao.channels,
      offset: cursor,
      channelStride: stride,
    });
    cursor += ao.channels * stride;
  }
  cursor = align(cursor);
  const audioOutSize = cursor - audioOutStart;

  // Param values
  const paramStart = cursor;
  const paramLayouts: ParamLayout[] = [];
  for (const p of g.declarations.params) {
    cursor = align(cursor);
    const isA = p.automationRate === "a-rate";
    const byteSize = isA ? renderQuantum * 4 : 16; // pad k-rate to 16 for alignment
    paramLayouts.push({
      paramId: p.id,
      automationRate: p.automationRate,
      offset: cursor,
      byteSize,
    });
    cursor += byteSize;
  }
  cursor = align(cursor);
  const paramSize = cursor - paramStart;

  // Event ring buffers
  const eventStart = cursor;
  const eventLayouts: EventLayout[] = [];
  for (const e of g.declarations.events) {
    cursor = align(cursor);
    const headerOffset = cursor;
    cursor += 16; // 4× u32 header
    const slotsOffset = cursor;
    // slot layout: [atSample u32][...fields...]
    let slotSize = 4; // atSample
    const fieldOffsets: Record<string, { offset: number; type: ScalarType }> = {};
    for (const f of e.fields) {
      fieldOffsets[f.name] = { offset: slotSize, type: f.type };
      slotSize += sizeOf(f.type);
    }
    // Pad slot to 8 bytes
    slotSize = (slotSize + 7) & ~7;
    cursor = slotsOffset + e.capacity * slotSize;
    cursor = align(cursor);
    const totalBytes = cursor - headerOffset;
    eventLayouts.push({
      eventId: e.id,
      capacity: e.capacity,
      headerOffset,
      slotsOffset,
      slotSize,
      fieldOffsets,
      totalBytes,
    });
  }
  cursor = align(cursor);
  const eventSize = cursor - eventStart;

  // Message ring buffers — slot scalars first, then per-slot content area
  // for typed-array payload fields.
  const messageStart = cursor;
  const messageLayouts: MessageLayout[] = [];
  for (const m of g.declarations.messages) {
    cursor = align(cursor);
    const headerOffset = cursor;
    cursor += 16;
    const slotsOffset = cursor;
    let slotSize = 0;
    const fieldOffsets: Record<string, { offset: number; type: ScalarType }> = {};
    for (const f of m.fields) {
      fieldOffsets[f.name] = { offset: slotSize, type: f.type };
      slotSize += sizeOf(f.type);
    }
    // Reserve two i32s per typed-array field: __off, __len.
    const payloadFields = (m.typedArrayFields ?? []).map((tf) => {
      const slotOffsetField = slotSize;
      slotSize += 4;
      const slotLengthField = slotSize;
      slotSize += 4;
      return { tf, slotOffsetField, slotLengthField };
    });
    slotSize = Math.max(8, (slotSize + 7) & ~7);
    cursor = slotsOffset + m.capacity * slotSize;
    cursor = align(cursor);
    // Per-slot content area
    let payloadStridePerSlot = 0;
    const expandedPayloadFields = payloadFields.map(({ tf, slotOffsetField, slotLengthField }) => {
      const bytesPerElem = tf.elemType === "u8" ? 1 : 4;
      const fieldBytes = tf.maxLength * bytesPerElem;
      const fieldOffsetWithinPayload = payloadStridePerSlot;
      payloadStridePerSlot += fieldBytes;
      // Align between fields to 16
      payloadStridePerSlot = (payloadStridePerSlot + 15) & ~15;
      return {
        name: tf.name,
        elemType: tf.elemType,
        maxLength: tf.maxLength,
        bytesPerElem,
        fieldOffsetWithinPayload,
        fieldBytes,
        slotOffsetField,
        slotLengthField,
      };
    });
    const payloadBufferOffset = cursor;
    const payloadBufferBytes = payloadStridePerSlot * m.capacity;
    cursor += payloadBufferBytes;
    cursor = align(cursor);
    const totalBytes = cursor - headerOffset;
    messageLayouts.push({
      messageId: m.id,
      capacity: m.capacity,
      headerOffset,
      slotsOffset,
      slotSize,
      fieldOffsets,
      payloadFields: expandedPayloadFields,
      payloadStridePerSlot,
      payloadBufferOffset,
      payloadBufferBytes,
      totalBytes,
    });
  }
  cursor = align(cursor);
  const messageSize = cursor - messageStart;

  // MIDI inputs
  const midiInStart = cursor;
  const midiInputLayouts: MidiLayout[] = [];
  for (const m of g.declarations.midiInputs) {
    cursor = align(cursor);
    const headerOffset = cursor;
    cursor += 16;
    const slotsOffset = cursor;
    cursor += m.capacity * 8;
    cursor = align(cursor);
    midiInputLayouts.push({
      midiId: m.id,
      capacity: m.capacity,
      headerOffset,
      slotsOffset,
      slotSize: 8,
      totalBytes: cursor - headerOffset,
    });
  }
  cursor = align(cursor);
  const midiInSize = cursor - midiInStart;

  // MIDI outputs
  const midiOutStart = cursor;
  const midiOutputLayouts: MidiLayout[] = [];
  for (const m of g.declarations.midiOutputs) {
    cursor = align(cursor);
    const headerOffset = cursor;
    cursor += 16;
    const slotsOffset = cursor;
    cursor += m.capacity * 8;
    cursor = align(cursor);
    midiOutputLayouts.push({
      midiId: m.id,
      capacity: m.capacity,
      headerOffset,
      slotsOffset,
      slotSize: 8,
      totalBytes: cursor - headerOffset,
    });
  }
  cursor = align(cursor);
  const midiOutSize = cursor - midiOutStart;

  const totalBytes = cursor;
  const PAGE = 64 * 1024;
  const initialPages = Math.max(1, Math.ceil(totalBytes / PAGE));

  return {
    stateRegion: { offset: stateStart, size: stateSize, slots: stateSlots },
    bufferRegion: { offset: bufferStart, size: bufferSize, buffers },
    audioInputs: { offset: audioInStart, size: audioInSize, inputs: audioInputs },
    audioOutputs: { offset: audioOutStart, size: audioOutSize, outputs: audioOutputs },
    params: { offset: paramStart, size: paramSize, layouts: paramLayouts },
    events: { offset: eventStart, size: eventSize, layouts: eventLayouts },
    messages: { offset: messageStart, size: messageSize, layouts: messageLayouts },
    midiInputs: { offset: midiInStart, size: midiInSize, layouts: midiInputLayouts },
    midiOutputs: { offset: midiOutStart, size: midiOutSize, layouts: midiOutputLayouts },
    totalBytes,
    initialPages,
    renderQuantum,
    maxInputChannels: maxInputCh,
    maxOutputChannels: maxOutputCh,
  };
}
