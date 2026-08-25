/**
 * `@unworklet/offline` — pure-JS offline renderer (`13-offline-render.md`).
 *
 * Single public entry point `renderOffline(processor, config)` runs an
 * `@unworklet/core` processor through host JS's `WebAssembly.instantiate`
 * (= Node / Bun / Deno) and returns the resulting PCM + emitted events +
 * end-of-render snapshot blob.
 *
 * Internally calls `compile(processor)` to obtain the WASM binary and the
 * driver-friendly handle (= `result.driver.instantiate()`), then drives memory
 * I/O + process() through that handle one render quantum at a time.
 *
 * Implemented: audio I/O + param + main→worklet `message<T>` injection +
 * worklet→main `event<T>` capture + bidirectional MIDI (= inbound `config.events`
 * injection / outbound `result.events` capture) + snapshot capture
 * (`result.state` = persistent slots) + restore (`config.restore` = initial state
 * injection + migration chain). Renders up to the sample count obtained by
 * rounding duration × sampleRate up to a `SAMPLES_PER_BLOCK` boundary
 * (= `13-offline-render.md` §2.1).
 */

import type { CompiledProcessor, MidiEvent, SnapshotSlot } from "@unworklet/core";
import {
  compile,
  decodeSnapshot,
  encodeScalar,
  encodeSnapshot,
  extractWorkletMeta,
  midiEventToWire,
  ringSlotIndex,
  runMigrations,
  SAMPLES_PER_BLOCK,
  wireToMidiEvent,
} from "@unworklet/core";

export { encodeWav } from "./encodeWav.ts";
export type { EncodeWavBitDepth, EncodeWavOptions } from "./encodeWav.ts";

export { decodeWav } from "./decodeWav.ts";
export type { DecodeWavResult } from "./decodeWav.ts";

/** Single main → worklet message scheduled for an offline render. */
export type OfflineMessage = {
  name: string;
  payload: unknown;
  /** Delivery quantum (block index, 0-based). Omitted = 0 (= render start). */
  atQuantum?: number;
};

/** Single inbound event injected at a sample-accurate offset. */
export type OfflineEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

/** Single worklet → main event recorded during a render. */
export type OfflineEmittedEvent = {
  name: string;
  payload: unknown;
  atSample: number;
};

export type RenderOfflineConfig = {
  sampleRate: number;
  /** Render duration in seconds; rounded up to the next `SAMPLES_PER_BLOCK` boundary. */
  duration: number;
  /** Audio input per declared `audioInput({ name })` port. Key = port name, value = per-channel `Float32Array`. */
  inputs?: Record<string, Float32Array[]>;
  /** Param automation per declared `param.named(...)` slot. Key = param name. */
  params?: Record<string, number[]>;
  /** Main → worklet messages scheduled by quantum index. */
  messages?: OfflineMessage[];
  /** Inbound events scheduled by sample-accurate offset. */
  events?: OfflineEvent[];
  /** Snapshot profile name; omitted = union of every `'persistent'` profile. */
  profile?: string;
  /**
   * Initial state blob written into the processor before rendering (= the
   * offline `restore` path, `13-offline-render.md` §2.x). Migrated to the
   * current schema via the processor's migration chain if the hashes differ.
   */
  restore?: Uint8Array;
};

/** Element byte size per snapshot scalar / buffer element type. */
const ELEMENT_BYTES: Record<string, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  i64: 8,
  bool: 4,
  u8: 1,
};

/** Default snapshot policy by declaration kind (`01-dsl.md` §3 / §8.2). */
function isPersistent(
  policy: unknown,
  defaultPolicy: "persistent" | "transient",
  profile: string | undefined,
): boolean {
  const p = policy ?? defaultPolicy;
  if (p === "persistent") return true;
  if (p === "transient") return false;
  const record = p as Record<string, string>;
  if (profile !== undefined) return record[profile] === "persistent";
  return Object.values(record).some((v) => v === "persistent");
}

export type RenderOfflineResult = {
  /** Output PCM per declared `audioOutput({ name })` port. */
  outputs: Record<string, Float32Array[]>;
  /** Events the processor emitted during the render. */
  events: OfflineEmittedEvent[];
  /** Snapshot blob (Q5 format) captured at end-of-render. */
  state: Uint8Array;
  /** Sample rate used for the render (= `config.sampleRate` carried through, self-describing for wav export / re-render / consumer automation). */
  sampleRate: number;
  /** Render-health counters. */
  diagnostics: {
    /**
     * Output samples the compiled processor's non-finite scrub replaced with 0
     * (a NaN / ±Inf the DSP produced — 0/0, x/0, a runaway accumulator).
     * 0 for a healthy render; anything else means the processor has a numeric
     * bug that would have propagated silence/clicks through Web Audio.
     */
    scrubbedSamples: number;
    /**
     * Outbound sysex messages the emit path refused because the requested
     * length does not fit the destination chunk or the source buffer. Shipping
     * the prefix that fits would deliver a sysex without its 0xF7 terminator,
     * so the message is dropped whole; this is how that loss is observed.
     */
    droppedSysexMessages: number;
  };
};

/** message / event ringbuffer header = [head, tail, overflowCount] × 4 bytes. */
const MESSAGE_HEADER_BYTES = 12;

/**
 * Per-(processor, sampleRate) compile memo. The compile pipeline (graph
 * re-capture → analysis → binaryen emit) dominates render wall time by an
 * order of magnitude on a mid-size processor, so a naturally-written suite —
 * one render per test — pays it once per test and times out (issue #39).
 * Sharing the `CompileResult` is state-safe: `driver.instantiate()` creates a
 * fresh WASM instance (fresh linear memory, state re-seeded from data
 * segments) per render.
 *
 * The value is the PROMISE, so concurrent renders coalesce onto one compile; a
 * rejected compile is evicted so a later attempt retries instead of replaying
 * a stale failure. Keyed by processor identity — a `defineProcessor` value is
 * a module singleton and treated as immutable once rendered.
 */
const compileCache = new WeakMap<
  object,
  Map<number, Promise<Awaited<ReturnType<typeof compile>>>>
>();

function compileMemo<C>(
  processor: CompiledProcessor<C>,
  sampleRate: number,
): Promise<Awaited<ReturnType<typeof compile>>> {
  let byRate = compileCache.get(processor);
  if (byRate === undefined) {
    byRate = new Map();
    compileCache.set(processor, byRate);
  }
  let pending = byRate.get(sampleRate);
  if (pending === undefined) {
    // Hand sampleRate to compile so the publish scheduler's threshold,
    // `Math.round(sampleRate / rateFps)`, is folded into a build-time constant.
    pending = compile(processor, { sampleRate });
    pending.catch(() => byRate.delete(sampleRate));
    byRate.set(sampleRate, pending);
  }
  return pending;
}

export async function renderOffline<C>(
  processor: CompiledProcessor<C>,
  config: RenderOfflineConfig,
): Promise<RenderOfflineResult> {
  const result = await compileMemo(processor, config.sampleRate);
  const instance = await result.driver.instantiate();

  // Obtain the event ring meta via WorkletMeta so renderOffline can walk the
  // ring directly in WASM memory: even without a SAB, it drains at the end of
  // each quantum and accumulates into the OfflineEmittedEvent array.
  //
  // Derive every region offset from the graph `compile` re-captured at the host
  // rate (`result.graph`), NOT the eager `processor.graph` (captured at the
  // default 48000): a buffer whose size depends on `ctx.sampleRate` lays the
  // buffers region out differently per rate, shifting the rings packed after it.
  // The eager offsets would then poke the host-rate WASM at the wrong place.
  const meta = extractWorkletMeta(result.graph as never);
  const eventRingMeta = meta.events.map((evt) => {
    const slot = meta.layout.regions.eventRings.slots[evt.name]!;
    return {
      name: evt.name,
      base: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      fields: slot.fields,
      // Content region holding the contents of typed-array fields (§4.3 worklet→main).
      payloadContent: meta.layout.regions.payloadContent.eventSlots[evt.name],
    };
  });
  const emittedEvents: OfflineEmittedEvent[] = [];

  // message ring meta (= for main → worklet injection). Unlike the worklet
  // template's SAB path, offline pokes the ring header / slot directly in WASM
  // memory and pushes at the start of a quantum (= a hand-written transport,
  // symmetric with the event drain).
  const messageRingMeta = meta.messages.map((msg) => {
    const slot = meta.layout.regions.messageRings.slots[msg.name]!;
    return {
      name: msg.name,
      base: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      // Content region holding typed-array field contents (= undefined if none).
      payloadContent: meta.layout.regions.payloadContent.messageSlots[msg.name],
      fields: slot.fields,
    };
  });

  // MIDI port rings (`11-midi.md` §4): 8-byte slots [status, data1, data2, _pad,
  // atSample:u32], header [head, tail, overflowCount]. Inbound ports take injected
  // events; outbound ports are drained into result.events as MidiEvent payloads.
  const MIDI_SLOT_BYTES = 8;
  const midiInPorts = meta.midiInputs.map((d) => ({
    name: d.name,
    ...meta.layout.regions.midiRings.slots[d.name]!,
    sysex: meta.layout.regions.sysexContent.slots[d.name],
  }));
  const midiOutPorts = meta.midiOutputs.map((d) => ({
    name: d.name,
    ...meta.layout.regions.midiRings.slots[d.name]!,
    sysex: meta.layout.regions.sysexContent.slots[d.name],
  }));

  const totalSamples =
    Math.ceil((config.duration * config.sampleRate) / SAMPLES_PER_BLOCK) * SAMPLES_PER_BLOCK;
  const blocks = totalSamples / SAMPLES_PER_BLOCK;

  const outputs: Record<string, Float32Array[]> = {};
  for (const decl of instance.declarations) {
    if (decl.kind === "audioOutput") {
      outputs[decl.name] = Array.from(
        { length: decl.channels },
        () => new Float32Array(totalSamples),
      );
    }
  }

  const blockBuffer = new Float32Array(SAMPLES_PER_BLOCK);
  const inputScratch = new Float32Array(SAMPLES_PER_BLOCK);
  const paramScratch = new Float32Array(SAMPLES_PER_BLOCK);
  // Last param value seen per param (= the snapshot's "current value" at end).
  const paramCurrent: Record<string, number> = {};

  // restore (= initial state injection, `13-offline-render.md` §2.x): migrate the
  // blob to the current schema, then write state / buffer values into linear
  // memory before the first quantum. Params follow `config.params`, not the blob.
  if (config.restore !== undefined) {
    // Identity gate BEFORE migrations (issue #28): schemaHash is declaration-
    // shape only, so a preset from a logically different processor can match
    // it and land in the wrong slots. In the offline (test-time) context a
    // cross-processor restore is a bug in the test — fail loud.
    const blobId = decodeSnapshot(config.restore).processorId;
    if (blobId !== null && processor.id !== undefined && blobId !== processor.id) {
      throw new Error(
        `unworklet: renderOffline config.restore — the snapshot belongs to processor ` +
          `"${blobId}", not "${processor.id}"; refusing to restore across processors. ` +
          `(stable ID 'processor-mismatch')`,
      );
    }
    const migrated = runMigrations(config.restore, processor.migrations ?? [], result.schemaHash);
    if (migrated.ok) {
      const decoded = decodeSnapshot(migrated.blob);
      const mem = instance.memory.buffer;
      for (const slot of decoded.slots) {
        // The declaration is the single width authority: a blob whose payload does
        // not match the declared slot width is skipped (fail-loud), never written
        // raw, so a mis-migrated slot cannot overrun into the regions packed after
        // it. Mirrors the worklet's applyRestoreSlots guard.
        if (slot.kind === "state") {
          const off = meta.layout.regions.states.slots[slot.name];
          const decl = meta.states.find((s) => s.name === slot.name);
          const expected = decl === undefined ? undefined : ELEMENT_BYTES[decl.type];
          if (off === undefined || expected === undefined || slot.data.length !== expected) {
            continue;
          }
          new Uint8Array(mem, off, expected).set(slot.data);
        } else if (slot.kind === "buffer") {
          const off = meta.layout.regions.buffers.slots[slot.name];
          const decl = meta.buffers.find((b) => b.name === slot.name);
          const expected = decl === undefined ? undefined : decl.size * ELEMENT_BYTES[decl.type]!;
          if (off === undefined || expected === undefined || slot.data.length !== expected) {
            continue;
          }
          new Uint8Array(mem, off, expected).set(slot.data);
        }
      }
    }
  }

  for (let b = 0; b < blocks; b++) {
    const blockStart = b * SAMPLES_PER_BLOCK;

    for (const decl of instance.declarations) {
      if (decl.kind === "audioInput") {
        const channels = config.inputs?.[decl.name] ?? [];
        for (let c = 0; c < decl.channels; c++) {
          const channelData = channels[c];
          if (channelData) {
            for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
              const abs = blockStart + s;
              inputScratch[s] = abs < channelData.length ? channelData[abs]! : 0;
            }
          } else {
            inputScratch.fill(0);
          }
          instance.writeInput(decl.name, c, inputScratch);
        }
      } else if (decl.kind === "param") {
        const data = config.params?.[decl.name];
        if (!data || data.length === 0) {
          paramScratch.fill(decl.default);
        } else if (data.length === 1) {
          paramScratch.fill(data[0]!);
        } else {
          for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
            const abs = blockStart + s;
            paramScratch[s] = abs < data.length ? data[abs]! : data[data.length - 1]!;
          }
        }
        instance.writeParam(decl.name, paramScratch);
        paramCurrent[decl.name] = paramScratch[SAMPLES_PER_BLOCK - 1]!;
      }
    }

    // message injection (= push the scheduled messages for this quantum onto the
    // ring head). The worklet's onReceive drain (= top of process, Q38-b) consumes
    // tail→head. tail was committed to head by the previous quantum's drain, so the
    // ring starts empty at each quantum.
    for (const m of config.messages ?? []) {
      if ((m.atQuantum ?? 0) !== b) continue;
      const ring = messageRingMeta.find((r) => r.name === m.name);
      if (ring === undefined) {
        throw new Error(
          `unworklet: renderOffline message "${m.name}" has no matching message<T> declaration`,
        );
      }
      const memory = instance.memory.buffer;
      const headerView = new Int32Array(memory, ring.base, 3);
      const head = headerView[0]!;
      const slotByteOffset =
        ring.base + MESSAGE_HEADER_BYTES + ringSlotIndex(head, ring.capacity) * ring.slotSize;
      const dataView = new DataView(memory);
      const payload = m.payload as Record<string, unknown>;
      for (const field of ring.fields) {
        const byteOffset = slotByteOffset + field.offsetInSlot;
        if (field.payloadElementType !== undefined) {
          // typed-array field = write the contents into payloadContent's per-slot
          // chunk and set [payloadLen(bytes), payloadOffset] on the slot (= §5.2 / Q85).
          // To keep content from being overwritten when multiple messages are queued
          // within one quantum, split the chunk per slot as
          // (head % chunks) × perChunk (= symmetric with emit / SAB). Bursts beyond
          // the chunk budget recycle cyclically = drop-oldest (= no trap).
          const src = payload[field.name] as Float32Array;
          const content = ring.payloadContent!;
          const perChunk = Math.floor(content.capacity / content.chunks);
          const payloadOffset = ringSlotIndex(head, content.chunks) * perChunk;
          const byteLen = Math.min(src.length * src.BYTES_PER_ELEMENT, perChunk);
          new Uint8Array(memory, content.base + payloadOffset, byteLen).set(
            new Uint8Array(src.buffer, src.byteOffset, byteLen),
          );
          dataView.setInt32(byteOffset, byteLen, true); // payloadLen (= bytes)
          dataView.setInt32(byteOffset + 4, payloadOffset, true); // payloadOffset (= per-slot chunk)
        } else if (field.wireType === "bool") {
          // boolean → bool wire (i32 0/1).
          dataView.setInt32(byteOffset, payload[field.name] ? 1 : 0, true);
        } else if (field.wireType === "i32") {
          // explicit i32 wire (e.g. a hand-built descriptor) → integer word.
          dataView.setInt32(byteOffset, Number(payload[field.name]) | 0, true);
        } else {
          // number → f32 wire; the declared `number` keeps its fraction.
          dataView.setFloat32(byteOffset, Number(payload[field.name]), true);
        }
      }
      headerView[0] = head + 1; // advance head by 1 slot (= push)
    }

    // MIDI inbound injection (= push the events for this quantum onto the matching
    // port ring). config.events.atSample is an absolute sample, so
    // quantum = floor(atSample / 128); the wire's atSample is block-local
    // (= atSample % 128). The worklet drain (= top of process, Q38-b) consumes
    // tail→head.
    for (const ev of config.events ?? []) {
      const port = midiInPorts.find((p) => p.name === ev.name);
      if (port === undefined) continue;
      if (Math.floor(ev.atSample / SAMPLES_PER_BLOCK) !== b) continue;
      const memory = instance.memory.buffer;
      const headerView = new Int32Array(memory, port.base, 3);
      const head = headerView[0]!;
      const slotByteOffset =
        port.base + MESSAGE_HEADER_BYTES + ringSlotIndex(head, port.capacity) * MIDI_SLOT_BYTES;
      const dv = new DataView(memory);
      const payload = ev.payload as MidiEvent;
      if (payload.type === "sysex") {
        // A sysex event sent to a port with no sysex region (the processor declares
        // no sysex handler) has nowhere to land — drop it rather than dereferencing
        // the absent region and crashing.
        if (port.sysex === undefined) continue;
        // Sysex: bytes → content chunk `[length, data]`, slot carries
        // `[0xF0, chunkIdx, _pad, _pad, atSample]` (`11-midi.md` §4.3).
        const region = port.sysex;
        const chunkIdx = ringSlotIndex(head, region.chunks);
        const chunkBase = region.base + chunkIdx * region.perChunk;
        const len = Math.min(payload.data.length, region.perChunk - 4);
        dv.setUint32(chunkBase, len, true);
        new Uint8Array(memory, chunkBase + 4, len).set(payload.data.subarray(0, len));
        dv.setUint8(slotByteOffset, 0xf0);
        dv.setUint8(slotByteOffset + 1, chunkIdx);
        dv.setUint32(slotByteOffset + 4, ev.atSample % SAMPLES_PER_BLOCK, true);
      } else {
        const { status, data1, data2 } = midiEventToWire(payload);
        dv.setUint8(slotByteOffset, status);
        dv.setUint8(slotByteOffset + 1, data1);
        dv.setUint8(slotByteOffset + 2, data2);
        dv.setUint8(slotByteOffset + 3, 0);
        dv.setUint32(slotByteOffset + 4, ev.atSample % SAMPLES_PER_BLOCK, true);
      }
      headerView[0] = head + 1;
    }

    instance.process();

    // event ring drain (= at the end of each quantum, accumulate however far the
    // WASM ring's head advanced into OfflineEmittedEvent). The in-WASM ring is
    // per-quantum self-contained: not advancing the ring tail leads to repeated
    // drop-oldest, so after draining commit tail = head (= stored directly via
    // WASM memory).
    for (const ring of eventRingMeta) {
      const memory = instance.memory.buffer;
      const headerView = new Int32Array(memory, ring.base, 3);
      let head = headerView[0]!;
      let tail = headerView[1]!;
      while (tail !== head) {
        const slotIdx = ringSlotIndex(tail, ring.capacity);
        const slotByteOffset = ring.base + 12 + slotIdx * ring.slotSize;
        const dataView = new DataView(memory);
        const payload: Record<string, unknown> = {};
        let atSample = 0;
        for (const field of ring.fields) {
          const byteOffset = slotByteOffset + field.offsetInSlot;
          // typed-array field (§4.3) = read the slot's [payloadLen, payloadOffset]
          // and slice a fresh Float32Array out of the content region (= a natural
          // array on the main side).
          if (field.payloadElementType !== undefined) {
            const payloadLen = dataView.getInt32(byteOffset, true); // bytes
            const payloadOffset = dataView.getInt32(byteOffset + 4, true);
            const srcBase = ring.payloadContent!.base + payloadOffset;
            const bytes = memory.slice(srcBase, srcBase + payloadLen); // fresh copy
            payload[field.name] =
              field.payloadElementType === "f64"
                ? new Float64Array(bytes)
                : field.payloadElementType === "u8"
                  ? new Uint8Array(bytes)
                  : field.payloadElementType === "i32" || field.payloadElementType === "bool"
                    ? new Int32Array(bytes)
                    : field.payloadElementType === "i64"
                      ? new BigInt64Array(bytes)
                      : new Float32Array(bytes);
            continue;
          }
          let value: number | boolean | bigint;
          switch (field.wireType) {
            case "i32":
            case "bool":
              value =
                field.wireType === "bool"
                  ? dataView.getInt32(byteOffset, true) !== 0
                  : dataView.getInt32(byteOffset, true);
              break;
            case "f32":
              value = dataView.getFloat32(byteOffset, true);
              break;
            /* v8 ignore start — f64 / i64 event fields are filled in a separate
               commit alongside the typed-array path at sub-phase 7.6 = unreachable
               defensive */
            case "f64":
              value = dataView.getFloat64(byteOffset, true);
              break;
            case "i64":
              value = dataView.getBigInt64(byteOffset, true);
              break;
            /* v8 ignore stop */
          }
          if (field.name === "atSample" && typeof value === "number") {
            // Block-local (0..SAMPLES_PER_BLOCK-1), matching online (B7 / Q4-c-ii).
            atSample = value;
          } else {
            payload[field.name] = value;
          }
        }
        emittedEvents.push({ name: ring.name, payload, atSample });
        tail += 1;
      }
      // After draining, commit tail = head (= the WASM ring starts empty at the
      // next quantum, preventing repeated drop-oldest). overflowCount is left
      // unreset (= kept monotonic).
      headerView[1] = head;
    }

    // MIDI outbound drain (= deserialize the midiOutput port's ring and accumulate
    // into OfflineEmittedEvent; payload = MidiEvent structure, compared directly by
    // §2.4 expectMidiOut). Per-quantum self-contained like the event ring = tail =
    // head at the end.
    for (const port of midiOutPorts) {
      const memory = instance.memory.buffer;
      const headerView = new Int32Array(memory, port.base, 3);
      const head = headerView[0]!;
      let tail = headerView[1]!;
      const dv = new DataView(memory);
      while (tail !== head) {
        const slotByteOffset =
          port.base + MESSAGE_HEADER_BYTES + ringSlotIndex(tail, port.capacity) * MIDI_SLOT_BYTES;
        const status = dv.getUint8(slotByteOffset);
        const data1 = dv.getUint8(slotByteOffset + 1);
        const data2 = dv.getUint8(slotByteOffset + 2);
        const slotAtSample = dv.getUint32(slotByteOffset + 4, true);
        let payload: MidiEvent;
        if (status === 0xf0 && port.sysex !== undefined) {
          // Sysex: chunkIdx = data1, content chunk = [length, bytes...].
          const region = port.sysex;
          const chunkBase = region.base + (data1 % region.chunks) * region.perChunk;
          const len = dv.getUint32(chunkBase, true);
          payload = {
            type: "sysex",
            data: new Uint8Array(memory.slice(chunkBase + 4, chunkBase + 4 + len)),
          };
        } else {
          payload = wireToMidiEvent(status, data1, data2);
        }
        // Block-local atSample (matches online + worklet→main events, B7 / Q4-c-ii).
        emittedEvents.push({ name: port.name, payload, atSample: slotAtSample });
        tail += 1;
      }
      headerView[1] = head;
    }

    for (const decl of instance.declarations) {
      if (decl.kind !== "audioOutput") continue;
      for (let c = 0; c < decl.channels; c++) {
        instance.readOutput(decl.name, c, blockBuffer);
        const dest = outputs[decl.name]![c]!;
        for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
          dest[blockStart + s] = blockBuffer[s]!;
        }
      }
    }
  }

  // Capture the end-of-render snapshot blob: named + 'persistent' state / buffer
  // slots read from linear memory, plus param current values (`05-client.md`
  // §2.6, `01-dsl.md` §8.2). `config.profile` selects which profile's persistent
  // slots are included; omitted = union of every persistent profile.
  const mem = instance.memory.buffer;
  const snapshotSlots: SnapshotSlot[] = [];
  for (const s of meta.states) {
    if (!s.userNamed || !isPersistent(s.snapshot, "persistent", config.profile)) continue;
    const off = meta.layout.regions.states.slots[s.name];
    if (off === undefined) continue;
    snapshotSlots.push({
      name: s.name,
      kind: "state",
      type: s.type,
      data: new Uint8Array(mem.slice(off, off + ELEMENT_BYTES[s.type]!)),
    });
  }
  for (const buf of meta.buffers) {
    if (!buf.userNamed || !isPersistent(buf.snapshot, "transient", config.profile)) continue;
    const off = meta.layout.regions.buffers.slots[buf.name];
    if (off === undefined) continue;
    const byteLen = buf.size * ELEMENT_BYTES[buf.type]!;
    snapshotSlots.push({
      name: buf.name,
      kind: "buffer",
      type: buf.type,
      data: new Uint8Array(mem.slice(off, off + byteLen)),
    });
  }
  for (const p of meta.params) {
    if (p.name === "" || !isPersistent(p.snapshot, "persistent", config.profile)) continue;
    snapshotSlots.push({
      name: p.name,
      kind: "param",
      type: "f32",
      data: encodeScalar("f32", paramCurrent[p.name] ?? p.default),
    });
  }
  const state = encodeSnapshot(
    result.schemaHash,
    config.profile ?? null,
    snapshotSlots,
    processor.id ?? null,
  );

  return {
    outputs,
    events: emittedEvents,
    state,
    sampleRate: config.sampleRate,
    diagnostics: {
      scrubbedSamples: instance.scrubbedSamples(),
      droppedSysexMessages: instance.droppedSysexMessages(),
    },
  };
}
