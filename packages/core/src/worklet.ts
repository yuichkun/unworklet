/**
 * The contents of the `CompiledProcessor.worklet` function namespace
 * (`01-dsl.md` §11, `04-worklet-runtime.md` §2, Q80).
 *
 * `makeWorkletNamespace(graph)` returns a per-processor closure with three
 * members:
 *
 * - `initialize(self, opts)` — instantiates the bytes from
 *   `opts.processorOptions.wasm` synchronously (`new WebAssembly.Module` /
 *   `new WebAssembly.Instance` behave identically in both the
 *   AudioWorkletGlobalScope and the Node test environment), stores the driver
 *   state behind an internal symbol on `self`, and acks readiness via
 *   `port.postMessage`.
 * - `process(self, inputs, outputs, parameters)` — runs the steps in
 *   `04-worklet-runtime.md` §2 order: block-length guard (Q75) → input/param
 *   marshal → WASM process → output marshal → return true.
 * - `parameterDescriptors` — converts the `param` declarations in the graph
 *   into Web Audio `AudioParamDescriptor` shape.
 *
 * Both the auto-register path (the worklet JS template the unplugin emits)
 * and the escape-hatch path (a user's own `class extends AudioWorkletProcessor`,
 * Q80) share this function namespace as their common foundation.
 */

import type {
  AudioPortDecl,
  BufferDecl,
  CapturedGraph,
  EventDeclAst,
  MessageDeclAst,
  MidiInputDecl,
  MidiOutputDecl,
  ParamDecl,
  StateDecl,
} from "./compile/ast.ts";
import { layout, type Layout } from "./compile/layout.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { ringCount, ringSlotIndex } from "./ringIndex.ts";
import {
  encodeScalar,
  isPersistent,
  SNAPSHOT_ELEMENT_BYTES,
  type SnapshotSlot,
} from "./snapshot.ts";
import type {
  EventRingSlotDescriptor,
  MessageRingSlotDescriptor,
  MidiRingSlotDescriptor,
  PublishSlotDescriptor,
  TransportMode,
  WorkletNamespace,
} from "./types.ts";

/**
 * Metadata bundle that fully describes a processor's worklet-side runtime
 * shape — everything needed to build a `WorkletNamespace` without
 * re-evaluating the authoring source. The unplugin computes this at
 * build / dev time from `compile(processor)` and inlines it (as JSON) into
 * the emitted worklet entry, so `audioWorklet.addModule()` only ever loads
 * a runtime-only artifact (= no `?worklet` virtual ever re-runs `defineProcessor`
 * inside `AudioWorkletGlobalScope`).
 */
export type WorkletMeta = {
  readonly layout: Layout;
  readonly audioInputs: readonly AudioPortDecl[];
  readonly audioOutputs: readonly AudioPortDecl[];
  readonly params: readonly ParamDecl[];
  /**
   * The list of state declarations carrying a publish flag (referenced by the
   * SAB copy logic in sub-phase 7.4). Zipped with
   * layout.regions.publishShared / publishCounters to obtain each slot's WASM
   * memory offset plus type (f32 / i32 / bool differ in SAB copy method, all
   * 4-byte words per Q42).
   */
  readonly publishStates: readonly StateDecl[];
  /**
   * The list of `event<T>` declarations (sub-phase 7.6). Zipped in declaration
   * order with the layout's eventRings slots. Referenced by the worklet
   * template's path that copies the WASM ring → SAB ring at the tail of each
   * quantum.
   */
  readonly events: readonly EventDeclAst[];
  /**
   * The list of `message<T>` declarations (sub-phase 7.7). Zipped in
   * declaration order with the layout's messageRings slots. Referenced by the
   * worklet template's path that mirrors the SAB ring → WASM ring at the start
   * of each quantum.
   */
  readonly messages: readonly MessageDeclAst[];
  /**
   * The list of `midiInput` / `midiOutput` declarations (`11-midi.md` §1).
   * Zipped in declaration order with the layout's midiRings slots. Referenced
   * by the path where the worklet template / offline renderer / main client
   * walks each port's ring (header + a run of 8-byte slots).
   */
  readonly midiInputs: readonly MidiInputDecl[];
  readonly midiOutputs: readonly MidiOutputDecl[];
  /**
   * All `state` / `buffer` declarations (used to decide what is in scope for a
   * snapshot). publishStates is the subset carrying a publish flag, but a
   * snapshot targets every named + persistent slot, so the full list is
   * required (the renderOffline / client blob-capture path).
   */
  readonly states: readonly StateDecl[];
  readonly buffers: readonly BufferDecl[];
};

export function extractWorkletMeta(graph: CapturedGraph): WorkletMeta {
  return {
    layout: layout(graph),
    audioInputs: graph.declarations.filter((d): d is AudioPortDecl => d.kind === "audioInput"),
    audioOutputs: graph.declarations.filter((d): d is AudioPortDecl => d.kind === "audioOutput"),
    params: graph.declarations.filter((d): d is ParamDecl => d.kind === "param"),
    publishStates: graph.declarations.filter(
      (d): d is StateDecl => d.kind === "state" && d.publish !== undefined,
    ),
    events: graph.declarations.filter((d): d is EventDeclAst => d.kind === "event"),
    messages: graph.declarations.filter((d): d is MessageDeclAst => d.kind === "message"),
    midiInputs: graph.declarations.filter((d): d is MidiInputDecl => d.kind === "midiInput"),
    midiOutputs: graph.declarations.filter((d): d is MidiOutputDecl => d.kind === "midiOutput"),
    states: graph.declarations.filter((d): d is StateDecl => d.kind === "state"),
    buffers: graph.declarations.filter((d): d is BufferDecl => d.kind === "buffer"),
  };
}

const BYTES_PER_F32 = 4;
const CHANNEL_STRIDE_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;
/** Fixed MIDI wire slot = `[status, data1, data2, _pad, atSample:u32]` (`11-midi.md` §4.1). */
const MIDI_SLOT_BYTES = 8;

const STATE_KEY = Symbol("unworklet.workletState");
/**
 * `initialize(self, opts)` was entered at least once. Used by `process` to
 * distinguish two failure modes when no state is attached to `self`:
 *
 *   - `INIT_CALLED_KEY === true` AND no state → initialize ran but threw
 *     before storing state (= init-error already posted at handshake time)
 *   - `INIT_CALLED_KEY === undefined` AND no state → init was never called
 *     (= path β escape hatch and the author forgot
 *     `def.worklet.initialize(this, opts)` in their constructor — Q80)
 *
 * The second case has no compile-time check (custom class lives in user
 * code), so the runtime posts `worklet-initialize-not-called` once and
 * keeps emitting silence — fail-fast signal to main without throwing on
 * the audio thread (= `00-foundations.md` §5.1 invariant 3).
 */
const INIT_CALLED_KEY = Symbol("unworklet.initCalled");
const INIT_NOT_CALLED_POSTED_KEY = Symbol("unworklet.initNotCalledPosted");

/**
 * Per-instance worklet state cached on the AudioWorkletProcessor `self`.
 * All `Float32Array` views over WASM linear memory are pre-bound during
 * `initialize(...)` and reused on every render quantum, because
 * `00-foundations.md` §5.1 forbids allocations / GC pressure on the audio
 * thread. unworklet's WASM module never calls `memory.grow` (= the layout
 * sizing is computed at compile time), so these views stay valid for the
 * processor's lifetime — they would otherwise need to be re-bound on every
 * growth event, since growth detaches the backing ArrayBuffer.
 */
/**
 * One queued inbound MIDI event on the postMessage path (`11-midi.md` §4.4).
 * Fixed events carry `status` / `data1` / `data2`; sysex carries `sysex` bytes
 * with `status = 0xF0`. `atSample` is the block-local sample-offset (§4.2).
 */
type MidiQueueItem = {
  status: number;
  data1: number;
  data2: number;
  atSample: number;
  sysex?: Uint8Array;
};

type WorkletState = {
  readonly process: () => void;
  readonly audioInputs: readonly AudioPortDecl[];
  readonly audioOutputs: readonly AudioPortDecl[];
  readonly params: readonly ParamDecl[];
  /** Index-aligned with `audioInputs`; inner array is per-channel views. */
  readonly inputViews: readonly Float32Array[][];
  /** Index-aligned with `audioOutputs`. */
  readonly outputViews: readonly Float32Array[][];
  /** Index-aligned with `params`. */
  readonly paramViews: readonly Float32Array[];
  /**
   * publish slot meta + buffer + per-slot lastVersion (sub-phase 7.4).
   * publishBuffer = the SAB or ArrayBuffer handed in by main (for main-side
   * observation); publishSlots = the offset map within WASM memory;
   * lastVersions[i] = the version last copied to main for slot i (skip when
   * unchanged). publishSlots.length === 0 with a null publishBuffer = a
   * processor with no publish. publishWasmSharedViews / CounterViews =
   * Int32Array views over the publishShared / publishCounters regions in WASM
   * memory (pre-bound in initialize to avoid audio-thread allocation).
   */
  readonly publishSharedView: Int32Array | null;
  readonly publishSlots: readonly PublishSlotDescriptor[];
  readonly lastVersions: number[];
  readonly transport: TransportMode;
  readonly publishWasmSharedViews: readonly Int32Array[];
  readonly publishWasmCounterViews: readonly Int32Array[];
  /**
   * event ring SAB copy meta (sub-phase 7.6 commit 5c). The eventRingsBuffer
   * (SAB or ArrayBuffer) handed in by main + a per-ring descriptor + each
   * ring's offset within the SAB. eventRingsWasmViews / SabViews = pre-bound
   * Uint8Array views (so the per-quantum bulk copy avoids per-quantum
   * allocation, for realtime safety). A processor with no event has null + an
   * empty array.
   */
  readonly eventRingsBuffer: SharedArrayBuffer | ArrayBuffer | null;
  readonly eventRings: readonly EventRingSlotDescriptor[];
  readonly eventRingSabOffsets: readonly number[];
  readonly eventRingsWasmViews: readonly Uint8Array[];
  readonly eventRingsSabViews: readonly Uint8Array[];
  /**
   * Slot-region-only views (= the ring minus its 12-byte header), pre-bound for
   * the out-ring publish bulk copy. The bulk copy must NOT span the header: the
   * SAB header is written solely by the release `Atomics.store(head)`, so a
   * consumer that acquire-loads the new head synchronizes-with the slot writes.
   * A whole-ring copy would also write head with a plain store before the
   * release, and a consumer could read-from that plain write and miss the
   * happens-before on the slots (a torn read).
   */
  readonly eventRingsWasmSlotViews: readonly Uint8Array[];
  readonly eventRingsSabSlotViews: readonly Uint8Array[];
  /** Per-ring header (head / tail / overflow) Int32Array view = for SAB Atomics.store */
  readonly eventRingsWasmHeaderViews: readonly Int32Array[];
  readonly eventRingsSabHeaderViews: readonly Int32Array[];
  /**
   * §4.3 content buffer per-ring view (non-null only for events with a
   * typed-array field, zipped with ring index). WASM = the read source (both
   * transports); SAB = the mirror target (SAB only).
   */
  readonly eventContentWasmViews: ReadonlyArray<Uint8Array | null>;
  readonly eventContentSabViews: ReadonlyArray<Uint8Array | null>;
  /**
   * For the postMessage path = per event ring, the "head value already sent to
   * main at the end of the previous quantum" / "the same overflow value". Only
   * when the next quantum detects "currentHead != lastSent" or
   * "currentOverflow != lastSent" is the diff delivered via port.postMessage
   * (an unchanged quantum is skipped). Not referenced on the SAB path (main
   * observes the SAB mirror copy directly via rAF polling).
   */
  readonly lastSentEventHeads: number[];
  readonly lastSentEventOverflows: number[];
  /**
   * message ring SAB ↔ WASM mirror meta (sub-phase 7.7d). Same zip pattern as
   * the event ring, but the push direction is reversed (main → worklet): at the
   * start of process, mirror SAB → WASM (bulk-copy the slots main pushed into
   * the WASM ring + commit head into the WASM ring); at the tail of the drain,
   * commit the WASM tail into the SAB tail (so main observes "drained").
   */
  readonly messageRingsBuffer: SharedArrayBuffer | ArrayBuffer | null;
  readonly messageRings: readonly MessageRingSlotDescriptor[];
  readonly messageRingSabOffsets: readonly number[];
  readonly messageRingsWasmViews: readonly Uint8Array[];
  /**
   * For the postMessage inject path = a DataView bound once over each message
   * ring's WASM region (for per-field setInt32). Allocating a
   * `new DataView(...)` every quantum in process() would allocate on the audio
   * thread, so it is reserved at init (same region as `messageRingsWasmViews`,
   * `00-foundations.md` §5.1).
   */
  readonly messageRingsWasmDataViews: readonly DataView[];
  readonly messageRingsSabViews: readonly Uint8Array[];
  readonly messageRingsWasmHeaderViews: readonly Int32Array[];
  readonly messageRingsSabHeaderViews: readonly Int32Array[];
  /**
   * §5.2 variable-length content buffer per-ring view (non-null only for
   * messages with a typed-array field, zipped with ring index). WASM = the
   * write target (both transports); SAB = the source mirroring what main has
   * pushed (SAB only).
   */
  readonly messageContentWasmViews: ReadonlyArray<Uint8Array | null>;
  readonly messageContentSabViews: ReadonlyArray<Uint8Array | null>;
  /**
   * For the postMessage path = each message ring's content-region write cursor
   * (advanced by byteLen per payload, then wraps). Unused on the SAB path,
   * which uses main's cursor (the worklet mirrors the whole region).
   */
  readonly messageContentCursors: number[];
  /**
   * For the postMessage path = a temporary queue holding payloads that main
   * sent via `port.postMessage({ kind: 'message', ringIndex, payload })`,
   * received on the audio thread's port.onmessage and pushed here. Injected
   * into the WASM ring + drained at the start of process (the substitute for
   * the SAB path's main → SAB → WASM mirror). Unused on the SAB path (stays an
   * empty array).
   */
  readonly messageQueueMirrors: Array<Array<Record<string, unknown>>>;
  /**
   * For the postMessage path = per message ring, the "overflow value already
   * sent to main at the end of the previous quantum". When drop-oldest fires
   * inside WASM and overflowCount increases, the diff is detected at the end of
   * the next quantum and main is notified via port.postMessage (the mirror
   * source for main's diagnostics.overflowCount()).
   */
  readonly lastSentMessageOverflows: number[];
  /**
   * MIDI ring SAB ↔ WASM mirror meta (`11-midi.md` §4). The in port shares the
   * message ring's transport (main → SAB / postMessage → WASM ring); the out
   * port shares the event ring's transport (WASM ring → SAB / postMessage →
   * main). The fixed 8-byte slot means no per-field DataView is needed = a
   * byte-level Uint8Array copy is sufficient.
   */
  readonly midiRingsBuffer: SharedArrayBuffer | ArrayBuffer | null;
  readonly midiRings: readonly MidiRingSlotDescriptor[];
  readonly midiRingsWasmViews: readonly Uint8Array[];
  /** Pre-bound DataView over all of WASM memory (for writing wire bytes / the atSample u32). */
  readonly midiWasmDataView: DataView | null;
  readonly midiRingsWasmHeaderViews: readonly Int32Array[];
  readonly midiRingsSabViews: readonly Uint8Array[];
  /**
   * Slot-region-only views (ring minus the 12-byte header) for the header-safe
   * bulk copy on both directions (out publish / in mirror). The header is
   * carried solely by the `Atomics` header words, never the plain bulk copy.
   */
  readonly midiRingsWasmSlotViews: readonly Uint8Array[];
  readonly midiRingsSabSlotViews: readonly Uint8Array[];
  readonly midiRingsSabHeaderViews: readonly Int32Array[];
  /** sysex content region view (non-null only for the sysex port, §4.3). Zipped with ring index. */
  readonly sysexContentWasmViews: ReadonlyArray<Uint8Array | null>;
  readonly sysexContentSabViews: ReadonlyArray<Uint8Array | null>;
  /** For the out port (event-like) postMessage path = the head / overflow sent in the previous quantum. */
  readonly lastSentMidiHeads: number[];
  readonly lastSentMidiOverflows: number[];
  /**
   * For the in port (message-like) postMessage path = events that main sent via
   * `port.postMessage({ kind:'midi', ... })`, accumulated on the audio thread
   * and injected into the WASM ring at the start of process. Zipped with ring
   * index (the out port is always empty).
   */
  readonly midiInQueues: Array<Array<MidiQueueItem>>;
  /** For the in port postMessage path = a mirror of how many times drop-oldest fired inside the WASM ring. */
  readonly lastSentMidiInOverflows: number[];
  /**
   * Latched once a WASM trap escapes `state.process()`. Subsequent quanta
   * emit silence and skip the WASM call so a single trap does not get
   * re-posted every render quantum (= main receives one `wasm-trap` event
   * and the node keeps outputting silence, per docs/05-client.md §4).
   */
  failed: boolean;
};

type SelfWithState = {
  port: { postMessage: (m: unknown) => void };
  [STATE_KEY]?: WorkletState;
  [INIT_CALLED_KEY]?: boolean;
  [INIT_NOT_CALLED_POSTED_KEY]?: boolean;
};

type ProcessorOptionsBag = {
  processorOptions?: {
    /**
     * Pre-compiled `WebAssembly.Module` minted on the main thread. Audio
     * thread only does `new WebAssembly.Instance(module)` (= fast,
     * deterministic, spec-recommended path). This is the primary handoff
     * shape produced by `createNode`.
     */
    module?: WebAssembly.Module;
    /**
     * Legacy `Uint8Array` bytes path = sync `new WebAssembly.Module(bytes)`
     * inside `initialize`. Kept for path β escape hatches (= an author's own
     * `class extends AudioWorkletProcessor` that hands raw bytes through
     * `processorOptions`), but the declarative path α prefers `.module`.
     */
    wasm?: Uint8Array;
    /**
     * Shared buffer for publish slots (sub-phase 7.4). A SharedArrayBuffer when
     * SAB is available, an ArrayBuffer in the fallback environment. At the tail
     * of each quantum the worklet template copies the WASM publishShared /
     * Counters values into this buffer (the main thread already holds a
     * reference to the same buffer, observed from both main and worklet). Not
     * handed in for a processor with no publish.
     */
    publishBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * The publish slot descriptor array (declaration order, zipped with the
     * slot placement in publishBuffer). For each slot the worklet template
     * obtains where in WASM memory to read from (sharedOffset / counterOffset).
     */
    publishSlots?: readonly PublishSlotDescriptor[];
    /**
     * transport mode ('sab' or 'postMessage'). Referenced by the worklet
     * template's path that switches the copy route. default = 'postMessage'
     * (the safer fallback).
     */
    transport?: TransportMode;
    /**
     * Shared buffer for the event ring buffer (sub-phase 7.6 commit 5b). A
     * single SAB (allocated by main) holding all event rings laid out
     * contiguously; at the tail of each quantum the worklet template copies the
     * WASM ring → SAB ring (filled in commit 5c). Not handed in for a processor
     * with no event.
     */
    eventRingsBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * The event ring descriptor array (declaration order, zipped with the
     * layout's eventRings slots). For each ring the worklet template obtains
     * where in WASM memory to read from (wasmRingBase / capacity / slotSize /
     * fields).
     */
    eventRings?: readonly EventRingSlotDescriptor[];
    /**
     * Each event ring's offset within the SAB (declaration order, zipped with
     * eventRings). The path where the worklet template takes the per-ring SAB
     * write base.
     */
    eventRingSabOffsets?: readonly number[];
    /**
     * SAB for the §4.3 content buffer (only when at least one event has a
     * typed-array field, SAB transport only). The worklet mirrors the WASM
     * content region here, and main reads it.
     */
    eventContentBuffer?: SharedArrayBuffer | ArrayBuffer;
    /** Each event ring's content offset within the SAB (zipped with ring index). */
    eventContentSabOffsets?: readonly number[];
    /**
     * Shared buffer for the message ring buffer (sub-phase 7.7d). A single SAB
     * (allocated by main) holding all message rings laid out contiguously; main
     * pushes slots into the SAB + the worklet template mirrors SAB → WASM ring
     * at the start of each quantum (the drain runs inside WASM). Not handed in
     * for a processor with no message.
     */
    messageRingsBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * The message ring descriptor array (declaration order, zipped with the
     * layout's messageRings slots).
     */
    messageRings?: readonly MessageRingSlotDescriptor[];
    /**
     * Each message ring's offset within the SAB (declaration order, zipped with
     * messageRings).
     */
    messageRingSabOffsets?: readonly number[];
    /**
     * SAB for the §5.2 variable-length content buffer (handed in only when at
     * least one message has a typed-array field, SAB transport only). All
     * content rings laid out contiguously; the per-ring base is taken from
     * messageContentSabOffsets.
     */
    messageContentBuffer?: SharedArrayBuffer | ArrayBuffer;
    /**
     * Each message ring's content offset within the SAB (zipped with ring
     * index; a ring with no content also holds 0 = the consumer decides by the
     * presence of descriptor.payloadContent).
     */
    messageContentSabOffsets?: readonly number[];
    /**
     * The MIDI ring descriptor array (`11-midi.md` §4, declaration order
     * midiInput → midiOutput). direction distinguishes in (same transport as
     * message) / out (same transport as event). in port = main pushes wire
     * slots + the worklet injects them into the WASM ring; out port = WASM emits
     * + the worklet drains them to main.
     */
    midiRings?: readonly MidiRingSlotDescriptor[];
    /**
     * A single SAB (allocated by main, SAB transport only) holding all MIDI
     * rings laid out contiguously. in port = main pushes into the SAB ring →
     * the worklet mirrors SAB → WASM up front; out port = the worklet mirrors
     * WASM → SAB at the tail → main drains via rAF.
     */
    midiRingsBuffer?: SharedArrayBuffer | ArrayBuffer;
    /** Each MIDI ring's offset within the SAB (zipped with midiRings). */
    midiRingSabOffsets?: readonly number[];
    /**
     * SAB for §4.3 sysex content (handed in only when at least one sysex port
     * exists, SAB transport only). The content regions of all sysex ports laid
     * out contiguously; the per-port base is taken from sysexContentSabOffsets.
     */
    sysexContentBuffer?: SharedArrayBuffer | ArrayBuffer;
    /** Each MIDI ring's sysex content offset within the SAB (zipped with midiRings, 0 when no sysex). */
    sysexContentSabOffsets?: readonly number[];
  };
};

const fillOutputsSilent = (outputs: Float32Array[][]): void => {
  for (const port of outputs) {
    for (const channel of port) {
      channel.fill(0);
    }
  }
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function makeWorkletNamespace(graph: CapturedGraph): WorkletNamespace {
  return makeWorkletNamespaceFromMeta(extractWorkletMeta(graph));
}

export function makeWorkletNamespaceFromMeta(meta: WorkletMeta): WorkletNamespace {
  const lay = meta.layout;
  const audioInputs = meta.audioInputs;
  const audioOutputs = meta.audioOutputs;
  const params = meta.params;
  const publishStates = meta.publishStates;

  const parameterDescriptors = params.map((p) => ({
    name: p.name,
    defaultValue: p.default,
    minValue: p.min,
    maxValue: p.max,
    automationRate: p.automationRate,
  }));

  const inputDescriptors = audioInputs.map((p) => ({ name: p.name, channels: p.channels }));
  const outputDescriptors = audioOutputs.map((p) => ({ name: p.name, channels: p.channels }));

  // publishSlots = build {name, type, sharedOffset, counterOffset} in declaration order.
  // Referenced when createNode detects the transport mode + allocates the SAB and the
  // worklet template copies through WASM memory into the SAB at the tail of each quantum
  // (sub-phase 7.4 / 7.5).
  const publishSlots = publishStates.map((s) => ({
    name: s.name,
    type: s.type,
    sharedOffset: lay.regions.publishShared.slots[s.name]!,
    counterOffset: lay.regions.publishCounters.slots[s.name]!,
  }));

  // eventRings = build {name, wasmRingBase, capacity, slotSize, fields} in declaration order.
  // Referenced when createNode allocates the SAB ringbuffer and the worklet template copies
  // the WASM ring → SAB ring at the tail of each quantum (sub-phase 7.6 commit 5b/5c).
  const eventRings: EventRingSlotDescriptor[] = meta.events.map((evt) => {
    const slot = lay.regions.eventRings.slots[evt.name];
    /* v8 ignore next 3 — the event declaration is already pushed into the layout
       at capture time = structurally unreachable defensive guard */
    if (slot === undefined) {
      throw new Error(`unworklet: missing layout slot for event "${evt.name}"`);
    }
    // An event with a typed-array field has a §4.3 content buffer. Put the WASM
    // base + capacity to mirror / directly extract the SAB content region into the descriptor.
    const content = lay.regions.payloadContent.eventSlots[evt.name];
    return {
      name: evt.name,
      wasmRingBase: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      fields: slot.fields,
      ...(content !== undefined
        ? { payloadContent: { wasmBase: content.base, capacity: content.capacity } }
        : {}),
    };
  });

  // messageRings = build the per-message descriptor in declaration order (sub-phase 7.7d).
  // Referenced when createNode allocates the messageRingsBuffer SAB and the worklet template
  // mirrors SAB → WASM at the start of each quantum.
  const messageRings: MessageRingSlotDescriptor[] = meta.messages.map((msg) => {
    const slot = lay.regions.messageRings.slots[msg.name];
    /* v8 ignore next 3 — the message declaration is already pushed into the layout
       at capture time = structurally unreachable defensive guard */
    if (slot === undefined) {
      throw new Error(`unworklet: missing layout slot for message "${msg.name}"`);
    }
    // A message with a typed-array field has a §5.2 content buffer (the layout's
    // payloadContent slot). Put the WASM base + capacity that the transport mirrors /
    // writes the SAB content region directly into onto the descriptor.
    const content = lay.regions.payloadContent.messageSlots[msg.name];
    return {
      name: msg.name,
      wasmRingBase: slot.base,
      capacity: slot.capacity,
      slotSize: slot.slotSize,
      fields: slot.fields,
      ...(content !== undefined
        ? { payloadContent: { wasmBase: content.base, capacity: content.capacity } }
        : {}),
    };
  });

  // midiRings = a descriptor laying midiInput / midiOutput out into one array in
  // declaration order (`11-midi.md` §4). direction distinguishes main → worklet (in,
  // same transport as message) / worklet → main (out, same transport as event). A sysex
  // port bundles the content region's wasmBase / perChunk / chunks (§4.3).
  // createNode sizes the SAB ring + sysex buffer, and the worklet template drains / emits.
  const midiDecls = [
    ...meta.midiInputs.map((d) => ({ decl: d, direction: "in" as const })),
    ...meta.midiOutputs.map((d) => ({ decl: d, direction: "out" as const })),
  ];
  const midiRings: MidiRingSlotDescriptor[] = midiDecls.map(({ decl, direction }) => {
    const slot = lay.regions.midiRings.slots[decl.name];
    /* v8 ignore next 3 — the midi declaration is already pushed into the layout
       at capture time = structurally unreachable defensive guard */
    if (slot === undefined) {
      throw new Error(`unworklet: missing layout slot for midi port "${decl.name}"`);
    }
    const sysex = lay.regions.sysexContent.slots[decl.name];
    return {
      name: decl.name,
      direction,
      wasmRingBase: slot.base,
      capacity: slot.capacity,
      ...(sysex !== undefined
        ? { sysex: { wasmBase: sysex.base, perChunk: sysex.perChunk, chunks: sysex.chunks } }
        : {}),
    };
  });

  const initialize: WorkletNamespace["initialize"] = (...args) => {
    const self = args[0] as SelfWithState;
    const opts = (args[1] ?? {}) as ProcessorOptionsBag;
    // Mark `initialize` as entered so `process()` can tell init-failed
    // (= flag set but no state) from init-never-called (= flag unset),
    // and surface the latter via `worklet-initialize-not-called`.
    self[INIT_CALLED_KEY] = true;
    try {
      // Prefer the pre-compiled `WebAssembly.Module` (= main-thread async
      // compile), fall back to sync `new WebAssembly.Module(bytes)` if a
      // path-β escape hatch still hands raw bytes through. Either way,
      // `new WebAssembly.Instance(module)` happens here in the audio
      // realm — that step is cheap + spec-recommended.
      const wasmModule =
        opts.processorOptions?.module ??
        (opts.processorOptions?.wasm
          ? new WebAssembly.Module(opts.processorOptions.wasm.buffer as ArrayBuffer)
          : null);
      if (!wasmModule) {
        throw new Error(
          "unworklet: `initialize(self, opts)` requires `opts.processorOptions.module` " +
            "(= pre-compiled WebAssembly.Module from main thread) or `opts.processorOptions.wasm` (= legacy bytes)",
        );
      }
      const instance = new WebAssembly.Instance(wasmModule);
      const memory = instance.exports["memory"] as WebAssembly.Memory;
      const procFn = instance.exports["process"] as () => void;

      // Pre-bind one Float32Array view per (port, channel) and per param.
      // Reused on every `process()` call to keep the audio thread alloc-free
      // (= `00-foundations.md` §5.1). Memory.grow is never invoked by
      // generated WASM = the views stay valid for the processor's lifetime.
      const inputViews: Float32Array[][] = [];
      for (const decl of audioInputs) {
        const portBase = lay.regions.ioScratch.inputs[decl.name]!;
        const channels: Float32Array[] = [];
        for (let c = 0; c < decl.channels; c++) {
          const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
          channels.push(new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK));
        }
        inputViews.push(channels);
      }

      const outputViews: Float32Array[][] = [];
      for (const decl of audioOutputs) {
        const portBase = lay.regions.ioScratch.outputs[decl.name]!;
        const channels: Float32Array[] = [];
        for (let c = 0; c < decl.channels; c++) {
          const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
          channels.push(new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK));
        }
        outputViews.push(channels);
      }

      const paramViews: Float32Array[] = [];
      for (const decl of params) {
        const paramBase = lay.regions.ioScratch.params[decl.name]!;
        paramViews.push(new Float32Array(memory.buffer, paramBase, SAMPLES_PER_BLOCK));
      }

      // Pull the publish-related meta + buffer out of opts (sub-phase 7.4).
      // A processor with no publish is handed in without a publishBuffer = view = null,
      // publishSlots = [], lastVersions = [] at start = the copy logic at the tail of
      // process walks nothing = no-op.
      const publishBuffer = opts.processorOptions?.publishBuffer ?? null;
      const publishSlots = opts.processorOptions?.publishSlots ?? [];
      const transport = opts.processorOptions?.transport ?? "postMessage";
      const publishSharedView = publishBuffer ? new Int32Array(publishBuffer) : null;
      const lastVersions = publishSlots.map(() => 0);
      // Pre-bind per-slot views over the publishShared / publishCounters regions
      // within WASM memory = the copy at the tail of process avoids per-quantum
      // allocation (`00-foundations.md` §5.1 realtime safety).
      const publishWasmSharedViews: Int32Array[] = [];
      const publishWasmCounterViews: Int32Array[] = [];
      for (const slot of publishSlots) {
        publishWasmSharedViews.push(new Int32Array(memory.buffer, slot.sharedOffset, 1));
        publishWasmCounterViews.push(new Int32Array(memory.buffer, slot.counterOffset, 2));
      }

      // Pull the event ring meta + buffer out of opts (sub-phase 7.6 commit 5c).
      // For each ring, pre-bind the Uint8Array views over WASM memory and the SAB,
      // then bulk-copy at the tail of each quantum + Atomics.store(head / overflow) to expose to main.
      const eventRingsBuffer = opts.processorOptions?.eventRingsBuffer ?? null;
      const eventRings = opts.processorOptions?.eventRings ?? [];
      const eventRingSabOffsets = opts.processorOptions?.eventRingSabOffsets ?? [];
      // §4.3 content buffer (only for events with a typed-array field). The worklet
      // mirrors the WASM content region into the SAB (SAB) / extracts it into the payload (postMessage).
      const eventContentBuffer = opts.processorOptions?.eventContentBuffer ?? null;
      const eventContentSabOffsets = opts.processorOptions?.eventContentSabOffsets ?? [];
      const eventRingsWasmViews: Uint8Array[] = [];
      const eventRingsSabViews: Uint8Array[] = [];
      const eventRingsWasmSlotViews: Uint8Array[] = [];
      const eventRingsSabSlotViews: Uint8Array[] = [];
      const eventRingsWasmHeaderViews: Int32Array[] = [];
      const eventRingsSabHeaderViews: Int32Array[] = [];
      const eventContentWasmViews: Array<Uint8Array | null> = [];
      const eventContentSabViews: Array<Uint8Array | null> = [];
      // For the postMessage path = track each ring's "head / overflow already sent
      // in the previous quantum" (the path that sends only the diff in the next
      // quantum). The SAB path never references it, so it stays at the initial 0.
      const lastSentEventHeads = eventRings.map(() => 0);
      const lastSentEventOverflows = eventRings.map(() => 0);
      // WASM views = needed on both transports (the path where the worklet reads
      // the WASM ring is common to SAB / postMessage). SAB views = bound only when
      // SAB is present (the postMessage path has no eventRingsBuffer).
      for (let i = 0; i < eventRings.length; i++) {
        const ring = eventRings[i]!;
        const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
        eventRingsWasmViews.push(new Uint8Array(memory.buffer, ring.wasmRingBase, ringTotalBytes));
        eventRingsWasmSlotViews.push(
          new Uint8Array(memory.buffer, ring.wasmRingBase + 12, ringTotalBytes - 12),
        );
        eventRingsWasmHeaderViews.push(new Int32Array(memory.buffer, ring.wasmRingBase, 3));
        if (eventRingsBuffer !== null) {
          eventRingsSabViews.push(
            new Uint8Array(eventRingsBuffer, eventRingSabOffsets[i]!, ringTotalBytes),
          );
          eventRingsSabSlotViews.push(
            new Uint8Array(eventRingsBuffer, eventRingSabOffsets[i]! + 12, ringTotalBytes - 12),
          );
          eventRingsSabHeaderViews.push(
            new Int32Array(eventRingsBuffer, eventRingSabOffsets[i]!, 3),
          );
        }
        const content = ring.payloadContent;
        if (content !== undefined) {
          eventContentWasmViews.push(
            new Uint8Array(memory.buffer, content.wasmBase, content.capacity),
          );
          const sabOffset = eventContentSabOffsets[i];
          eventContentSabViews.push(
            eventContentBuffer !== null && sabOffset !== undefined
              ? new Uint8Array(eventContentBuffer, sabOffset, content.capacity)
              : null,
          );
        } else {
          eventContentWasmViews.push(null);
          eventContentSabViews.push(null);
        }
      }

      // message ring meta + buffer pre-bind. Same zip pattern as the event ring, but
      // the mirror direction is reversed (main → worklet). The route branches on
      // transport mode:
      //
      // - SAB available: main pushes into the SAB + the worklet bulk-copies SAB →
      //   WASM at the start of process + commits the WASM tail into the SAB tail at the tail of the drain
      // - SAB unavailable: no shared buffer, main sends directly via `port.postMessage({
      //   kind:'message', ringIndex, payload })` = the worklet receives it on
      //   self.port.onmessage + pushes to messageQueueMirrors + injects per field into
      //   the WASM ring at the start of process + notifies main of the in-WASM
      //   overflowCount via port.postMessage at the tail (updates the main mirror).
      //
      // WASM views = needed on both transports (the worklet writes the WASM ring).
      // SAB views = bound only when SAB is present.
      const messageRingsBuffer = opts.processorOptions?.messageRingsBuffer ?? null;
      const messageRings = opts.processorOptions?.messageRings ?? [];
      const messageRingSabOffsets = opts.processorOptions?.messageRingSabOffsets ?? [];
      // §5.2 variable-length content buffer (only for messages with a typed-array field).
      // On SAB = mirror what main has pushed into the content SAB into the WASM region at
      // the start of each quantum; on postMessage = write the payload's typed array directly
      // into the WASM region on the audio thread. Zipped with ring index (a ring with no content is null).
      const messageContentBuffer = opts.processorOptions?.messageContentBuffer ?? null;
      const messageContentSabOffsets = opts.processorOptions?.messageContentSabOffsets ?? [];
      const messageRingsWasmViews: Uint8Array[] = [];
      const messageRingsWasmDataViews: DataView[] = [];
      const messageRingsSabViews: Uint8Array[] = [];
      const messageRingsWasmHeaderViews: Int32Array[] = [];
      const messageRingsSabHeaderViews: Int32Array[] = [];
      const messageContentWasmViews: Array<Uint8Array | null> = [];
      const messageContentSabViews: Array<Uint8Array | null> = [];
      const messageContentCursors: number[] = messageRings.map(() => 0);
      const messageQueueMirrors: Array<Array<Record<string, unknown>>> = messageRings.map(() => []);
      const lastSentMessageOverflows = messageRings.map(() => 0);
      for (let i = 0; i < messageRings.length; i++) {
        const ring = messageRings[i]!;
        const ringTotalBytes = 12 + ring.capacity * ring.slotSize;
        messageRingsWasmViews.push(
          new Uint8Array(memory.buffer, ring.wasmRingBase, ringTotalBytes),
        );
        messageRingsWasmDataViews.push(
          new DataView(memory.buffer, ring.wasmRingBase, ringTotalBytes),
        );
        messageRingsWasmHeaderViews.push(new Int32Array(memory.buffer, ring.wasmRingBase, 3));
        if (messageRingsBuffer !== null) {
          messageRingsSabViews.push(
            new Uint8Array(messageRingsBuffer, messageRingSabOffsets[i]!, ringTotalBytes),
          );
          messageRingsSabHeaderViews.push(
            new Int32Array(messageRingsBuffer, messageRingSabOffsets[i]!, 3),
          );
        }
        const content = ring.payloadContent;
        if (content !== undefined) {
          messageContentWasmViews.push(
            new Uint8Array(memory.buffer, content.wasmBase, content.capacity),
          );
          const sabOffset = messageContentSabOffsets[i];
          messageContentSabViews.push(
            messageContentBuffer !== null && sabOffset !== undefined
              ? new Uint8Array(messageContentBuffer, sabOffset, content.capacity)
              : null,
          );
        } else {
          messageContentWasmViews.push(null);
          messageContentSabViews.push(null);
        }
      }

      // MIDI ring meta + buffer pre-bind (`11-midi.md` §4). The fixed 8-byte slot means
      // event / message's per-field DataView is unnecessary = a byte-level Uint8Array copy.
      // in port = same as message (main → WASM); out port = same as event (WASM → main).
      const midiRingsBuffer = opts.processorOptions?.midiRingsBuffer ?? null;
      const midiRingsMeta = opts.processorOptions?.midiRings ?? [];
      const midiRingSabOffsets = opts.processorOptions?.midiRingSabOffsets ?? [];
      const sysexContentBuffer = opts.processorOptions?.sysexContentBuffer ?? null;
      const sysexContentSabOffsets = opts.processorOptions?.sysexContentSabOffsets ?? [];
      const midiRingsWasmViews: Uint8Array[] = [];
      // Bind a DataView over all of WASM memory once for writing wire bytes / the
      // atSample u32 (avoids per-quantum allocation, `00-foundations.md` §5.1). null when no MIDI.
      const midiWasmDataView = midiRingsMeta.length > 0 ? new DataView(memory.buffer) : null;
      const midiRingsWasmHeaderViews: Int32Array[] = [];
      const midiRingsSabViews: Uint8Array[] = [];
      const midiRingsWasmSlotViews: Uint8Array[] = [];
      const midiRingsSabSlotViews: Uint8Array[] = [];
      const midiRingsSabHeaderViews: Int32Array[] = [];
      const sysexContentWasmViews: Array<Uint8Array | null> = [];
      const sysexContentSabViews: Array<Uint8Array | null> = [];
      const lastSentMidiHeads = midiRingsMeta.map(() => 0);
      const lastSentMidiOverflows = midiRingsMeta.map(() => 0);
      const midiInQueues: Array<Array<MidiQueueItem>> = midiRingsMeta.map(() => []);
      const lastSentMidiInOverflows = midiRingsMeta.map(() => 0);
      for (let i = 0; i < midiRingsMeta.length; i++) {
        const ring = midiRingsMeta[i]!;
        const ringTotalBytes = 12 + ring.capacity * MIDI_SLOT_BYTES;
        midiRingsWasmViews.push(new Uint8Array(memory.buffer, ring.wasmRingBase, ringTotalBytes));
        midiRingsWasmSlotViews.push(
          new Uint8Array(memory.buffer, ring.wasmRingBase + 12, ringTotalBytes - 12),
        );
        midiRingsWasmHeaderViews.push(new Int32Array(memory.buffer, ring.wasmRingBase, 3));
        if (midiRingsBuffer !== null) {
          midiRingsSabViews.push(
            new Uint8Array(midiRingsBuffer, midiRingSabOffsets[i]!, ringTotalBytes),
          );
          midiRingsSabSlotViews.push(
            new Uint8Array(midiRingsBuffer, midiRingSabOffsets[i]! + 12, ringTotalBytes - 12),
          );
          midiRingsSabHeaderViews.push(new Int32Array(midiRingsBuffer, midiRingSabOffsets[i]!, 3));
        }
        const sysex = ring.sysex;
        if (sysex !== undefined) {
          const sysexBytes = sysex.perChunk * sysex.chunks;
          sysexContentWasmViews.push(new Uint8Array(memory.buffer, sysex.wasmBase, sysexBytes));
          const sabOffset = sysexContentSabOffsets[i];
          sysexContentSabViews.push(
            sysexContentBuffer !== null && sabOffset !== undefined
              ? new Uint8Array(sysexContentBuffer, sabOffset, sysexBytes)
              : null,
          );
        } else {
          sysexContentWasmViews.push(null);
          sysexContentSabViews.push(null);
        }
      }

      (self as SelfWithState)[STATE_KEY] = {
        process: procFn,
        audioInputs,
        audioOutputs,
        params,
        inputViews,
        outputViews,
        paramViews,
        publishSharedView,
        publishSlots,
        lastVersions,
        transport,
        publishWasmSharedViews,
        publishWasmCounterViews,
        eventRingsBuffer,
        eventRings,
        eventRingSabOffsets,
        eventRingsWasmViews,
        eventRingsSabViews,
        eventRingsWasmSlotViews,
        eventRingsSabSlotViews,
        eventRingsWasmHeaderViews,
        eventRingsSabHeaderViews,
        eventContentWasmViews,
        eventContentSabViews,
        lastSentEventHeads,
        lastSentEventOverflows,
        messageRingsBuffer,
        messageRings,
        messageRingSabOffsets,
        messageRingsWasmViews,
        messageRingsWasmDataViews,
        messageRingsSabViews,
        messageRingsWasmHeaderViews,
        messageRingsSabHeaderViews,
        messageContentWasmViews,
        messageContentSabViews,
        messageContentCursors,
        messageQueueMirrors,
        lastSentMessageOverflows,
        midiRingsBuffer,
        midiRings: midiRingsMeta,
        midiRingsWasmViews,
        midiWasmDataView,
        midiRingsWasmHeaderViews,
        midiRingsSabViews,
        midiRingsWasmSlotViews,
        midiRingsSabSlotViews,
        midiRingsSabHeaderViews,
        sysexContentWasmViews,
        sysexContentSabViews,
        lastSentMidiHeads,
        lastSentMidiOverflows,
        midiInQueues,
        lastSentMidiInOverflows,
        failed: false,
      };

      // Incoming-message listener for the postMessage path (receive on the audio
      // thread what the main-side sender sends via `port.postMessage({ kind: 'message',
      // ringIndex, payload })`, push to messageQueueMirrors[i], and inject into the WASM
      // ring at the start of the next process). On SAB the main-side sender writes
      // directly into the SAB = the listener is dropped.
      // snapshot / restore needs no SAB = handled by postMessage request/response.
      // The worklet's port.onmessage runs at render quantum boundaries (the same
      // audio thread as process(), but between quanta), so reading / writing linear
      // memory here is structurally block-atomic (`06-runtime.md` §6.1). capture
      // reads persistent state / buffer / param; restore writes state / buffer
      // (param is applied to the AudioParam on the main side). Mirrors the same logic
      // as offline's end-of-render capture / config.restore.
      const captureSnapshotSlots = (profile: string | undefined): SnapshotSlot[] => {
        const out: SnapshotSlot[] = [];
        const buf = memory.buffer;
        for (const s of meta.states) {
          if (s.userNamed !== true || !isPersistent(s.snapshot, "persistent", profile)) continue;
          const off = lay.regions.states.slots[s.name];
          if (off === undefined) continue;
          out.push({
            name: s.name,
            kind: "state",
            type: s.type,
            data: new Uint8Array(buf.slice(off, off + SNAPSHOT_ELEMENT_BYTES[s.type]!)),
          });
        }
        for (const b of meta.buffers) {
          if (b.userNamed !== true || !isPersistent(b.snapshot, "transient", profile)) continue;
          const off = lay.regions.buffers.slots[b.name];
          if (off === undefined) continue;
          const byteLen = b.size * SNAPSHOT_ELEMENT_BYTES[b.type]!;
          out.push({
            name: b.name,
            kind: "buffer",
            type: b.type,
            data: new Uint8Array(buf.slice(off, off + byteLen)),
          });
        }
        for (let pi = 0; pi < meta.params.length; pi++) {
          const p = meta.params[pi]!;
          if (p.name === "" || !isPersistent(p.snapshot, "persistent", profile)) continue;
          out.push({
            name: p.name,
            kind: "param",
            type: "f32",
            data: encodeScalar("f32", paramViews[pi]![SAMPLES_PER_BLOCK - 1]!),
          });
        }
        return out;
      };
      // Dev-only X-ray (DEVTOOLS integration §4): the unfiltered counterpart of
      // `captureSnapshotSlots` — every state / buffer / param regardless of
      // `userNamed` or snapshot policy, so the devtools panel can read the whole
      // live memory (incl. anonymous `__state_N` / transient slots). Dormant in
      // production: no `dev-dump-request` is sent without the dev page-script.
      const captureDevDumpSlots = (): SnapshotSlot[] => {
        const out: SnapshotSlot[] = [];
        const buf = memory.buffer;
        for (const s of meta.states) {
          const off = lay.regions.states.slots[s.name];
          if (off === undefined) continue;
          out.push({
            name: s.name,
            kind: "state",
            type: s.type,
            data: new Uint8Array(buf.slice(off, off + SNAPSHOT_ELEMENT_BYTES[s.type]!)),
          });
        }
        for (const b of meta.buffers) {
          const off = lay.regions.buffers.slots[b.name];
          if (off === undefined) continue;
          const byteLen = b.size * SNAPSHOT_ELEMENT_BYTES[b.type]!;
          out.push({
            name: b.name,
            kind: "buffer",
            type: b.type,
            data: new Uint8Array(buf.slice(off, off + byteLen)),
          });
        }
        for (let pi = 0; pi < meta.params.length; pi++) {
          const p = meta.params[pi]!;
          if (p.name === "") continue;
          out.push({
            name: p.name,
            kind: "param",
            type: "f32",
            data: encodeScalar("f32", paramViews[pi]![SAMPLES_PER_BLOCK - 1]!),
          });
        }
        return out;
      };
      const applyRestoreSlots = (
        slots: ReadonlyArray<SnapshotSlot>,
        // The blob's profile scopes which declarations are "expected" — `missing`
        // is computed against it, not the union of every profile (`01-dsl.md` §8.2).
        profile: string | undefined,
      ): { applied: string[]; skipped: string[]; missing: string[] } => {
        const applied: string[] = [];
        const skipped: string[] = [];
        const buf = memory.buffer;
        const provided = new Set(slots.map((s) => s.name));
        for (const slot of slots) {
          if (slot.kind === "state") {
            const off = lay.regions.states.slots[slot.name];
            if (off === undefined) {
              skipped.push(slot.name);
              continue;
            }
            // A corrupt / mis-migrated blob can hand a payload that does not match
            // the declared slot width. Writing it raw would overrun the slot and
            // corrupt adjacent state, so the declaration is the single authority:
            // a size mismatch is rejected (= skipped, fail-loud), never written.
            const decl = meta.states.find((s) => s.name === slot.name);
            const expected = decl === undefined ? undefined : SNAPSHOT_ELEMENT_BYTES[decl.type];
            if (expected === undefined || slot.data.length !== expected) {
              skipped.push(slot.name);
              continue;
            }
            new Uint8Array(buf, off, expected).set(slot.data);
            applied.push(slot.name);
          } else if (slot.kind === "buffer") {
            const off = lay.regions.buffers.slots[slot.name];
            if (off === undefined) {
              skipped.push(slot.name);
              continue;
            }
            // Declared byte size = size × element width (= the layout's slot bound).
            // Same authority as state: a blob that does not match it is rejected,
            // never clamped-and-written — a too-large payload would otherwise spill
            // past the buffer into the regions packed after it.
            const decl = meta.buffers.find((b) => b.name === slot.name);
            const expected =
              decl === undefined ? undefined : decl.size * SNAPSHOT_ELEMENT_BYTES[decl.type]!;
            if (expected === undefined || slot.data.length !== expected) {
              skipped.push(slot.name);
              continue;
            }
            new Uint8Array(buf, off, expected).set(slot.data);
            applied.push(slot.name);
          } else {
            // param slot = the AudioParam's value (actually set on the main side). The
            // worklet, as the single authority of the declaration, only decides presence
            // (present → applied, absent → skipped); the value is applied by main's restore().
            if (meta.params.some((p) => p.name === slot.name)) applied.push(slot.name);
            else skipped.push(slot.name);
          }
        }
        const missing: string[] = [];
        for (const s of meta.states) {
          if (
            s.userNamed === true &&
            isPersistent(s.snapshot, "persistent", profile) &&
            !provided.has(s.name)
          ) {
            missing.push(s.name);
          }
        }
        for (const b of meta.buffers) {
          if (
            b.userNamed === true &&
            isPersistent(b.snapshot, "transient", profile) &&
            !provided.has(b.name)
          ) {
            missing.push(b.name);
          }
        }
        for (const p of meta.params) {
          if (
            p.name !== "" &&
            isPersistent(p.snapshot, "persistent", profile) &&
            !provided.has(p.name)
          ) {
            missing.push(p.name);
          }
        }
        return { applied, skipped, missing };
      };

      const port = self.port as {
        addEventListener?: (kind: string, handler: (event: MessageEvent) => void) => void;
        start?: () => void;
      };
      if (typeof port.addEventListener === "function") {
        port.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as
            | {
                kind?: unknown;
                ringIndex?: unknown;
                payload?: unknown;
                item?: unknown;
                requestId?: unknown;
                profile?: unknown;
                slots?: unknown;
              }
            | null
            | undefined;
          if (typeof data !== "object" || data === null) return;
          if (data.kind === "snapshot-request") {
            const profile = typeof data.profile === "string" ? data.profile : undefined;
            // capture must always answer: an unhandled throw posts nothing and
            // `client.snapshot()` awaits a reply that never comes (= hang).
            let slots: SnapshotSlot[];
            try {
              slots = captureSnapshotSlots(profile);
            } catch {
              slots = [];
            }
            self.port.postMessage({
              kind: "snapshot-response",
              requestId: data.requestId,
              slots,
            });
            return;
          }
          if (data.kind === "dev-dump-request") {
            // Same always-answer contract as snapshot: never hang the requester.
            let slots: SnapshotSlot[];
            try {
              slots = captureDevDumpSlots();
            } catch {
              slots = [];
            }
            self.port.postMessage({
              kind: "dev-dump-response",
              requestId: data.requestId,
              slots,
            });
            return;
          }
          if (data.kind === "restore") {
            const slots = Array.isArray(data.slots) ? (data.slots as SnapshotSlot[]) : [];
            const profile = typeof data.profile === "string" ? data.profile : undefined;
            // Same contract as capture: the handler must always post `restore-done`
            // so the awaiting client settles. On an unexpected throw mid-apply,
            // report nothing applied (= the live node keeps its current state).
            let report: { applied: string[]; skipped: string[]; missing: string[] };
            try {
              report = applyRestoreSlots(slots, profile);
            } catch {
              report = {
                applied: [],
                skipped: slots
                  .map((s) => (s as { name?: unknown })?.name)
                  .filter((n): n is string => typeof n === "string"),
                missing: [],
              };
            }
            self.port.postMessage({ kind: "restore-done", requestId: data.requestId, ...report });
            return;
          }
          if (data.kind === "message") {
            if (typeof data.ringIndex !== "number") return;
            const ringIndex = data.ringIndex;
            if (ringIndex < 0 || ringIndex >= messageRings.length) return;
            if (typeof data.payload !== "object" || data.payload === null) return;
            // Bound ingress by ring capacity (drop-oldest). Even if main posts a burst
            // beyond capacity within one quantum, the queue does not grow, so process()'s
            // `for (const payload of queue)` drain loop is not proportional to the burst
            // on the audio thread = not an unbounded loop (`00-foundations.md` §5.1
            // invariant 2). The dropped count is recorded in the WASM ring overflow counter
            // (same overflowCount semantics as the SAB path's ring drop-oldest, notified to
            // main at the tail of process).
            const queue = messageQueueMirrors[ringIndex]!;
            if (queue.length >= messageRings[ringIndex]!.capacity) {
              queue.shift();
              const wasmH = messageRingsWasmHeaderViews[ringIndex]!;
              wasmH[2] = wasmH[2]! + 1;
            }
            queue.push(data.payload as Record<string, unknown>);
            return;
          }
          if (data.kind === "midi") {
            // inbound MIDI (main's `node.midi.<name>.send(...)`). Like message, accumulate
            // in a queue + bound by capacity (drop-oldest), and inject into the WASM in-ring
            // at the start of process (§4.4 postMessage path).
            if (typeof data.ringIndex !== "number") return;
            const ringIndex = data.ringIndex;
            if (ringIndex < 0 || ringIndex >= midiRingsMeta.length) return;
            if (midiRingsMeta[ringIndex]!.direction !== "in") return;
            const item = data.item as MidiQueueItem | null | undefined;
            if (typeof item !== "object" || item === null) return;
            const queue = midiInQueues[ringIndex]!;
            if (queue.length >= midiRingsMeta[ringIndex]!.capacity) {
              queue.shift();
              const wasmH = midiRingsWasmHeaderViews[ringIndex]!;
              wasmH[2] = wasmH[2]! + 1;
            }
            queue.push(item);
          }
        });
        // MessagePort spec = the addEventListener route does not implicitly start =
        // an explicit start() enables receiving (the onmessage = ... path auto-starts,
        // but the addEventListener path needs it separately).
        if (typeof port.start === "function") {
          port.start();
        }
      }

      self.port.postMessage({ kind: "ready" });
    } catch (err) {
      // Surface the failure via a structured handshake message so
      // `createNode()` on main can reject with context (= debug clarity
      // beyond `processorerror`, which carries no payload per MDN).
      // Do NOT rethrow: the audio thread must not propagate exceptions
      // (= `00-foundations.md` §5.1 invariant 3), subsequent `process()`
      // calls will see no state and emit silence.
      self.port.postMessage({
        kind: "init-error",
        message: errorMessage(err),
      });
    }
  };

  const process: WorkletNamespace["process"] = (...args): boolean => {
    const self = args[0] as SelfWithState;
    const inputs = args[1] as Float32Array[][];
    const outputs = args[2] as Float32Array[][];
    const parameters = args[3] as Record<string, Float32Array>;

    const state = (self as SelfWithState)[STATE_KEY];
    if (!state) {
      // No state attached = two distinct paths. Post the path-β-specific
      // signal once if `initialize` was never called (= author forgot
      // `def.worklet.initialize(this, opts)`); otherwise stay silent
      // (= initialize ran but threw, in which case `init-error` was
      // already posted during the createNode handshake). Either way:
      // emit silence, `return true` to keep the AudioWorkletProcessor
      // alive, no throw on the audio thread.
      const initCalled = self[INIT_CALLED_KEY] === true;
      if (!initCalled && !self[INIT_NOT_CALLED_POSTED_KEY]) {
        self.port.postMessage({ kind: "error", code: "worklet-initialize-not-called" });
        self[INIT_NOT_CALLED_POSTED_KEY] = true;
      }
      fillOutputsSilent(outputs);
      return true;
    }
    if (state.failed) {
      // A previous quantum trapped inside `state.process()`. Per
      // docs/05-client.md §4 the node stays connected + outputs silence
      // for the rest of its lifetime — the wasm-trap message was already
      // posted once, do not flood the port.
      fillOutputsSilent(outputs);
      return true;
    }

    // 04-worklet-runtime.md §3 / §8 / Q75 — block-length runtime guard.
    // First mismatch latches `state.failed` (= same uniform fallback path
    // as wasm-trap) so every subsequent quantum stays silent for the rest
    // of the node's lifetime, even if the host transiently returns to the
    // expected length. The single mismatch event is posted once; later
    // quanta short-circuit on `state.failed` above before reaching here.
    const firstOut = outputs[0]?.[0];
    if (firstOut && firstOut.length !== SAMPLES_PER_BLOCK) {
      state.failed = true;
      fillOutputsSilent(outputs);
      self.port.postMessage({
        kind: "error",
        code: "block-length-mismatch",
        expected: SAMPLES_PER_BLOCK,
        received: firstOut.length,
      });
      return true;
    }

    // Marshal inputs into linear memory ioScratch.inputs[port][channel].
    // All views were pre-bound in `initialize` = no Float32Array allocation
    // on the audio thread.
    const inputViews = state.inputViews;
    for (let portIdx = 0; portIdx < state.audioInputs.length; portIdx++) {
      const decl = state.audioInputs[portIdx]!;
      const portInput = inputs[portIdx] ?? [];
      const portViews = inputViews[portIdx]!;
      for (let c = 0; c < decl.channels; c++) {
        const view = portViews[c]!;
        // A mono source feeding a stereo-declared port hands us fewer channels
        // than declared (AudioWorklet channelCountMode 'max'). Up-mix the missing
        // channel from channel 0 (Web Audio 'speakers' convention) so every
        // declared channel carries signal — otherwise the right output is silent
        // ("left-only"). A fully disconnected port (no channel 0) stays silence.
        const src = portInput[c] ?? portInput[0];
        if (src && src.length === SAMPLES_PER_BLOCK) {
          view.set(src);
        } else {
          view.fill(0);
        }
      }
    }

    // Marshal parameters into linear memory ioScratch.params[name].
    // AudioWorklet hands us length 0 (= no automation, use declared default),
    // 1 (= k-rate or unchanged a-rate, broadcast), or SAMPLES_PER_BLOCK
    // (= per-sample a-rate). 08-deployment.md §2 A3 unifies them at this seam.
    const paramViews = state.paramViews;
    for (let i = 0; i < state.params.length; i++) {
      const decl = state.params[i]!;
      const view = paramViews[i]!;
      const data = parameters[decl.name];
      if (!data || data.length === 0) {
        view.fill(decl.default);
      } else if (data.length === 1) {
        view.fill(data[0]!);
      } else {
        view.set(data);
      }
    }

    // message ring mirror = the route branches on transport mode (at the start of
    // process, inject what main pushed into the WASM ring + the drain logic runs inside WASM):
    //
    // - SAB available: main has pushed into the SAB = acquire the header via Atomics.load
    //   first, then bulk-copy SAB → WASM (§5.5 acquire-before-read) + reflect into the WASM ring.
    // - SAB unavailable: no shared buffer = main sends directly via port.postMessage
    //   = it is accumulated in messageQueueMirrors[i] = at the start of process, inject
    //   each payload per field into a WASM ring slot + fire drop-oldest on overflow +
    //   internal overflowCount += 1 (notified to main at the tail).
    if (state.messageRings.length > 0) {
      const isSab = state.transport === "sab";
      if (isSab && state.messageRingsBuffer !== null) {
        // SAB path = existing SAB → WASM bulk copy + header mirror
        const wasmViews = state.messageRingsWasmViews;
        const sabViews = state.messageRingsSabViews;
        const wasmHeaders = state.messageRingsWasmHeaderViews;
        const sabHeaders = state.messageRingsSabHeaderViews;
        for (let i = 0; i < wasmViews.length; i++) {
          const sabH = sabHeaders[i]!;
          const wasmH = wasmHeaders[i]!;
          const prevHead = wasmH[0]!;
          // §5.5 consumer protocol: acquire-load head, then copy the slot data.
          // The producer (main) writes the slot → release-store(head) in that order,
          // so if acquire-load(head) comes before the slot copy, "the slot bytes head
          // observed" are visible via happens-before. Placing the copy before the
          // acquire would torn-read a concurrent producer write.
          wasmH[0] = Atomics.load(sabH, 0);
          wasmH[1] = Atomics.load(sabH, 1);
          wasmH[2] = Atomics.load(sabH, 2);
          wasmViews[i]!.set(sabViews[i]!);
          // For a ring with a typed-array field = mirror the entire content region
          // SAB → WASM only on quanta where head advanced (§5.2; the slot's payloadOffset
          // is an absolute index relative to the region base = a full mirror keeps the
          // addressing consistent). If head is unchanged there is no new payload = skip
          // the large region memcpy.
          const contentWasm = state.messageContentWasmViews[i];
          const contentSab = state.messageContentSabViews[i];
          if (contentWasm !== null && contentSab !== null && wasmH[0]! !== prevHead) {
            contentWasm.set(contentSab);
          }
        }
      } else {
        // postMessage path = inject messageQueueMirrors into the WASM ring
        for (let i = 0; i < state.messageRings.length; i++) {
          const queue = state.messageQueueMirrors[i]!;
          if (queue.length === 0) continue;
          const ring = state.messageRings[i]!;
          const wasmH = state.messageRingsWasmHeaderViews[i]!;
          // Reuse the ring view pre-bound at init (avoids per-quantum DataView
          // allocation on the audio thread, `00-foundations.md` §5.1).
          const wasmDataView = state.messageRingsWasmDataViews[i]!;
          const capacity = ring.capacity;
          const slotSize = ring.slotSize;
          for (const payload of queue) {
            const head = wasmH[0]!;
            const tail = wasmH[1]!;
            // overflow check = ringCount(head, tail) >= capacity = drop-oldest
            if (ringCount(head, tail) >= capacity) {
              wasmH[1] = tail + 1;
              wasmH[2] = wasmH[2]! + 1;
            }
            // slot write (Q46 uniform lift: every number → i32 / boolean → 0/1 i32,
            // typed-array → bytes into the §5.2 content region + [payloadLen, payloadOffset] into the slot)
            const slotByteOffset = 12 + ringSlotIndex(head, capacity) * slotSize;
            for (const field of ring.fields) {
              const value = payload[field.name];
              const byteOffset = slotByteOffset + field.offsetInSlot;
              if (field.payloadElementType !== undefined) {
                const contentWasm = state.messageContentWasmViews[i];
                if (contentWasm !== null && ArrayBuffer.isView(value)) {
                  // Truncate a payload larger than the content region (Q85: no-trap.
                  // Without clamping, contentWasm.set would throw a RangeError on the audio thread).
                  const copyBytes = Math.min(value.byteLength, contentWasm.length);
                  const src = new Uint8Array(value.buffer, value.byteOffset, copyBytes);
                  let cursor = state.messageContentCursors[i]!;
                  // If it would straddle the end of the region, wrap to the start (drop-oldest).
                  if (cursor + copyBytes > contentWasm.length) cursor = 0;
                  contentWasm.set(src, cursor);
                  wasmDataView.setUint32(byteOffset, copyBytes, true);
                  wasmDataView.setUint32(byteOffset + 4, cursor, true);
                  state.messageContentCursors[i] = cursor + copyBytes;
                }
              } else if (typeof value === "boolean") {
                wasmDataView.setInt32(byteOffset, value ? 1 : 0, true);
              } else if (typeof value === "number") {
                wasmDataView.setInt32(byteOffset, value | 0, true);
              }
            }
            wasmH[0] = head + 1;
          }
          queue.length = 0;
        }
      }
    }

    // MIDI in-ring inject = same transport as message (main → WASM). Q38-b: the handler
    // drains before per-block / forSample, so the inject happens before the WASM process.
    //
    // - SAB available: main has pushed into the SAB ring = acquire-load the header first,
    //   then bulk-copy SAB → WASM (§5.5 acquire-before-read) + also mirror sysex content when head advances.
    // - SAB unavailable: accumulated in midiInQueues = write each item into a WASM ring slot
    //   as wire bytes + drop-oldest on overflow + internal overflowCount += 1.
    if (state.midiRings.length > 0) {
      const isSab = state.transport === "sab";
      const dv = state.midiWasmDataView!;
      for (let i = 0; i < state.midiRings.length; i++) {
        const ring = state.midiRings[i]!;
        if (ring.direction !== "in") continue;
        const wasmH = state.midiRingsWasmHeaderViews[i]!;
        if (isSab && state.midiRingsBuffer !== null) {
          // SAB path = SAB → WASM bulk copy (slot copy after header acquire-load)
          const sabH = state.midiRingsSabHeaderViews[i]!;
          const prevHead = wasmH[0]!;
          wasmH[0] = Atomics.load(sabH, 0);
          wasmH[1] = Atomics.load(sabH, 1);
          wasmH[2] = Atomics.load(sabH, 2);
          state.midiRingsWasmViews[i]!.set(state.midiRingsSabViews[i]!);
          const sysexWasm = state.sysexContentWasmViews[i];
          const sysexSab = state.sysexContentSabViews[i];
          if (sysexWasm !== null && sysexSab !== null && wasmH[0]! !== prevHead) {
            sysexWasm.set(sysexSab);
          }
        } else {
          // postMessage path = inject midiInQueues into the WASM ring as wire bytes
          const queue = state.midiInQueues[i]!;
          if (queue.length === 0) continue;
          const capacity = ring.capacity;
          const sysexWasm = state.sysexContentWasmViews[i];
          for (const item of queue) {
            const head = wasmH[0]!;
            const tail = wasmH[1]!;
            if (ringCount(head, tail) >= capacity) {
              wasmH[1] = tail + 1;
              wasmH[2] = wasmH[2]! + 1;
            }
            const slotByteOffset = 12 + ringSlotIndex(head, capacity) * MIDI_SLOT_BYTES;
            if (item.sysex !== undefined && ring.sysex !== undefined && sysexWasm !== null) {
              // sysex = [length, data] into the content chunk, [0xF0, chunkIdx, _, _, atSample] into the slot
              const region = ring.sysex;
              const chunkIdx = ringSlotIndex(head, region.chunks);
              const chunkBase = chunkIdx * region.perChunk;
              const len = Math.min(item.sysex.length, region.perChunk - 4);
              dv.setUint32(ring.sysex.wasmBase + chunkBase, len, true);
              sysexWasm.set(item.sysex.subarray(0, len), chunkBase + 4);
              dv.setUint8(ring.wasmRingBase + slotByteOffset, 0xf0);
              dv.setUint8(ring.wasmRingBase + slotByteOffset + 1, chunkIdx);
              dv.setUint32(ring.wasmRingBase + slotByteOffset + 4, item.atSample, true);
            } else {
              dv.setUint8(ring.wasmRingBase + slotByteOffset, item.status);
              dv.setUint8(ring.wasmRingBase + slotByteOffset + 1, item.data1);
              dv.setUint8(ring.wasmRingBase + slotByteOffset + 2, item.data2);
              dv.setUint8(ring.wasmRingBase + slotByteOffset + 3, 0);
              dv.setUint32(ring.wasmRingBase + slotByteOffset + 4, item.atSample, true);
            }
            wasmH[0] = head + 1;
          }
          queue.length = 0;
        }
      }
    }

    try {
      state.process();
    } catch (err) {
      // WASM trap during process() (= div-by-zero, OOB memory access,
      // unreachable instruction, etc. V8 surfaces these as JS exceptions
      // of `WebAssembly.RuntimeError` per the WebAssembly spec). Latch
      // failed state so subsequent quanta short-circuit, emit silence for
      // this quantum, and surface the trap to main via `onError` channel.
      // Keep returning true so the AudioWorkletProcessor stays alive (=
      // node stays connected per docs/05-client.md §4).
      state.failed = true;
      fillOutputsSilent(outputs);
      self.port.postMessage({
        kind: "error",
        code: "wasm-trap",
        message: errorMessage(err),
      });
      return true;
    }

    // Marshal outputs from linear memory ioScratch.outputs[port][channel].
    const outputViews = state.outputViews;
    for (let portIdx = 0; portIdx < state.audioOutputs.length; portIdx++) {
      const decl = state.audioOutputs[portIdx]!;
      const portOutput = outputs[portIdx] ?? [];
      const portViews = outputViews[portIdx]!;
      for (let c = 0; c < decl.channels; c++) {
        const view = portViews[c]!;
        const dest = portOutput[c];
        if (dest) {
          dest.set(view);
        }
      }
    }

    // publish copy (sub-phase 7.4 + postMessage path fix). Walk only the slots whose
    // version in publishCounters the WASM publish scheduler updated, and deliver the
    // value to main when the version advances. The route branches on transport mode:
    //
    // - SAB available: update the shared SAB via Atomics.store (main does rAF polling
    //   + Atomics.load to avoid a torn read + detects the version advance and dispatches).
    // - SAB unavailable: no shared buffer (structured clone gives main / worklet
    //   separate instances, so a mirror is impossible) = notify main individually via
    //   port.postMessage. main updates its mirror state immediately on port.onmessage +
    //   dispatches to subscribers (no rAF polling needed, per `02-messaging.md` §4 /
    //   `04-worklet-runtime.md` §7).
    //
    // The version-advance check is unified; only the delivery route branches.
    const slots = state.publishSlots;
    const lastVersions = state.lastVersions;
    const sharedViews = state.publishWasmSharedViews;
    const counterViews = state.publishWasmCounterViews;
    const isSab = state.transport === "sab";
    const sharedView = state.publishSharedView;
    for (let i = 0; i < slots.length; i++) {
      const counterView = counterViews[i]!;
      const currentVersion = counterView[1]!;
      if (currentVersion !== lastVersions[i]) {
        const valueBits = sharedViews[i]![0]!;
        const sampleCounter = counterView[0]!;
        if (isSab && sharedView !== null) {
          const slotIdx = i * 3;
          Atomics.store(sharedView, slotIdx, valueBits);
          Atomics.store(sharedView, slotIdx + 1, sampleCounter);
          Atomics.store(sharedView, slotIdx + 2, currentVersion);
        } else {
          // postMessage path = a flag-bearing notification to main. Identified by
          // slotIndex; valueBits carries the publish value as an i32 bit pattern
          // (reinterpreted per type on the main side); sampleCounter is for
          // diagnostics; version is the anchor for comparing against main's local lastSeenVersion.
          self.port.postMessage({
            kind: "publish",
            slotIndex: i,
            valueBits,
            sampleCounter,
            version: currentVersion,
          });
        }
        lastVersions[i] = currentVersion;
      }
    }

    // event ring copy = the route branches on transport mode:
    //
    // - SAB available: existing SAB bulk copy (mirror the whole ring into the SAB) +
    //   header Atomics.store (main does rAF polling + Atomics.load to take the head
    //   release fence and guarantee visibility of the slot run).
    // - SAB unavailable: no shared buffer (structured clone gives main / worklet
    //   separate ring instances) = extract the newly emitted range (lastSentHead ..
    //   currentHead) as a Uint8Array slice + deliver via port.postMessage (main turns
    //   it into payload objects on onEventMessage + dispatches to subscribers;
    //   overflowCount is carried on the payload to update the main mirror). An
    //   unchanged quantum is skipped.
    //
    // Note: the per-quantum `new Uint8Array(...)` allocation on the postMessage path is
    // slated to be refactored, before v1.0.0 ship, to the 02-messaging §4 "pre-allocated
    // transferable buffers + ownership transfer" ping-pong path (this wave is "make it work").
    if (state.eventRings.length > 0) {
      const wasmViews = state.eventRingsWasmViews;
      const sabSlotViews = state.eventRingsSabSlotViews;
      const wasmSlotViews = state.eventRingsWasmSlotViews;
      const wasmHeaders = state.eventRingsWasmHeaderViews;
      const sabHeaders = state.eventRingsSabHeaderViews;
      const isSab = state.transport === "sab";
      for (let i = 0; i < state.eventRings.length; i++) {
        const ring = state.eventRings[i]!;
        const wasmH = wasmHeaders[i]!;
        const currentHead = wasmH[0]!;
        const currentTail = wasmH[1]!;
        const currentOverflow = wasmH[2]!;
        if (isSab && state.eventRingsBuffer !== null) {
          // SAB path = slot-region bulk copy (NOT the header) + header Atomics.store.
          // Copying the header here would write `head` with a plain store before the
          // release store below, letting a consumer read-from it without the
          // happens-before that publishes the slots (a torn read).
          sabSlotViews[i]!.set(wasmSlotViews[i]!);
          // §4.3 with a typed-array field = mirror the content region WASM → SAB
          // (before the head Atomics.store = the release fence lets main observe it through the slots).
          const contentWasm = state.eventContentWasmViews[i];
          const contentSab = state.eventContentSabViews[i];
          if (contentWasm !== null && contentSab !== null) {
            contentSab.set(contentWasm);
          }
          const sabH = sabHeaders[i]!;
          // head is the release point: commit tail + overflow FIRST so a consumer
          // that acquire-loads the new head already sees the matching window. Storing
          // head first lets a cross-thread reader pair a new head with a stale tail /
          // overflow and miscompute the drop-oldest clamp (= event garble race).
          Atomics.store(sabH, 1, currentTail);
          Atomics.store(sabH, 2, currentOverflow);
          Atomics.store(sabH, 0, currentHead);
        } else {
          // postMessage path = extract the newly emitted range + deliver via port.postMessage
          const lastSentHead = state.lastSentEventHeads[i]!;
          const lastSentOverflow = state.lastSentEventOverflows[i]!;
          if (currentHead === lastSentHead && currentOverflow === lastSentOverflow) continue;
          // drop-oldest may have advanced tail past lastSentHead = re-anchor with max
          // (the old slots have already overflowed, so skip them).
          const from = lastSentHead < currentTail ? currentTail : lastSentHead;
          const newSlotCount = currentHead - from;
          const slotSize = ring.slotSize;
          const capacity = ring.capacity;
          const wasmRawView = wasmViews[i]!;
          // bulk-copy the new slots into a Uint8Array (main decodes the fields)
          const slotsBytes = new Uint8Array(newSlotCount * slotSize);
          for (let k = 0; k < newSlotCount; k++) {
            const slotIdx = ringSlotIndex(from + k, capacity);
            const srcOffset = 12 + slotIdx * slotSize;
            slotsBytes.set(wasmRawView.subarray(srcOffset, srcOffset + slotSize), k * slotSize);
          }
          const eventMsg: {
            kind: "event";
            ringIndex: number;
            newSlotsBytes: ArrayBuffer;
            newSlotCount: number;
            overflowCount: number;
            contentBytes?: ArrayBuffer;
          } = {
            kind: "event",
            ringIndex: i,
            newSlotsBytes: slotsBytes.buffer,
            newSlotCount,
            overflowCount: currentOverflow,
          };
          // §4.3 with a typed-array field = bundle a content-region snapshot (main never
          // touches WASM memory = it slices from here using the slot's payloadOffset/Len).
          const contentWasm = state.eventContentWasmViews[i];
          if (contentWasm !== null) {
            eventMsg.contentBytes = contentWasm.slice().buffer;
          }
          self.port.postMessage(eventMsg);
          state.lastSentEventHeads[i] = currentHead;
          state.lastSentEventOverflows[i] = currentOverflow;
        }
      }
    }

    // message ring tail commit / overflow notify = the route branches on transport mode:
    //
    // - SAB available: commit the tail advanced by the WASM drain into the SAB (main
    //   observes "up to drained" via Atomics.load on the SAB tail).
    // - SAB unavailable: when drop-oldest fired inside WASM = overflowCount has changed
    //   = notify main via port.postMessage (main's messageOverflowMirror updates + it is
    //   readable via diagnostics.overflowCount()). No tail commit is needed (this path has
    //   no main-side mirror = no SAB tail observation).
    if (state.messageRings.length > 0) {
      const isSab = state.transport === "sab";
      const wasmHeaders = state.messageRingsWasmHeaderViews;
      if (isSab && state.messageRingsBuffer !== null) {
        const sabHeaders = state.messageRingsSabHeaderViews;
        for (let i = 0; i < wasmHeaders.length; i++) {
          const wasmH = wasmHeaders[i]!;
          const sabH = sabHeaders[i]!;
          Atomics.store(sabH, 1, wasmH[1]!);
        }
      } else {
        for (let i = 0; i < wasmHeaders.length; i++) {
          const wasmH = wasmHeaders[i]!;
          const currentOverflow = wasmH[2]!;
          if (currentOverflow !== state.lastSentMessageOverflows[i]) {
            self.port.postMessage({
              kind: "message-overflow",
              ringIndex: i,
              overflowCount: currentOverflow,
            });
            state.lastSentMessageOverflows[i] = currentOverflow;
          }
        }
      }
    }

    // MIDI ring copy / commit = the route branches on direction (`11-midi.md` §4.4):
    //
    // - out port (same as event): SAB = WASM ring → SAB bulk copy + sysex content mirror
    //   + header Atomics.store. postMessage = extract the new slots + deliver `{ kind:'midiOut' }`.
    // - in port (same as message): SAB = commit the WASM drain tail into the SAB tail (the
    //   source main observes for its drop-oldest decision). postMessage = notify overflow changes via `{ kind:'midi-overflow' }`.
    if (state.midiRings.length > 0) {
      const isSab = state.transport === "sab";
      for (let i = 0; i < state.midiRings.length; i++) {
        const ring = state.midiRings[i]!;
        const wasmH = state.midiRingsWasmHeaderViews[i]!;
        if (ring.direction === "out") {
          const currentHead = wasmH[0]!;
          const currentTail = wasmH[1]!;
          const currentOverflow = wasmH[2]!;
          if (isSab && state.midiRingsBuffer !== null) {
            // Slot-region copy only — the header is carried by the release
            // Atomics.store below, never the plain bulk copy (= no torn read).
            state.midiRingsSabSlotViews[i]!.set(state.midiRingsWasmSlotViews[i]!);
            const sysexWasm = state.sysexContentWasmViews[i];
            const sysexSab = state.sysexContentSabViews[i];
            if (sysexWasm !== null && sysexSab !== null) {
              sysexSab.set(sysexWasm);
            }
            const sabH = state.midiRingsSabHeaderViews[i]!;
            // head is the release point: commit tail + overflow FIRST so a consumer
            // that acquire-loads the new head already sees the matching window
            // (= same release order as the event out ring).
            Atomics.store(sabH, 1, currentTail);
            Atomics.store(sabH, 2, currentOverflow);
            Atomics.store(sabH, 0, currentHead);
          } else {
            const lastSentHead = state.lastSentMidiHeads[i]!;
            const lastSentOverflow = state.lastSentMidiOverflows[i]!;
            if (currentHead === lastSentHead && currentOverflow === lastSentOverflow) continue;
            const from = lastSentHead < currentTail ? currentTail : lastSentHead;
            const newSlotCount = currentHead - from;
            const capacity = ring.capacity;
            const wasmRawView = state.midiRingsWasmViews[i]!;
            const slotsBytes = new Uint8Array(newSlotCount * MIDI_SLOT_BYTES);
            for (let k = 0; k < newSlotCount; k++) {
              const slotIdx = ringSlotIndex(from + k, capacity);
              const srcOffset = 12 + slotIdx * MIDI_SLOT_BYTES;
              slotsBytes.set(
                wasmRawView.subarray(srcOffset, srcOffset + MIDI_SLOT_BYTES),
                k * MIDI_SLOT_BYTES,
              );
            }
            const midiOutMsg: {
              kind: "midiOut";
              ringIndex: number;
              newSlotsBytes: ArrayBuffer;
              newSlotCount: number;
              overflowCount: number;
              sysexBytes?: ArrayBuffer;
            } = {
              kind: "midiOut",
              ringIndex: i,
              newSlotsBytes: slotsBytes.buffer,
              newSlotCount,
              overflowCount: currentOverflow,
            };
            // sysex port = bundle a content-region snapshot (main never touches WASM =
            // it reads the length-prefixed bytes from here using the slot's chunkIdx).
            const sysexWasm = state.sysexContentWasmViews[i];
            if (sysexWasm !== null) {
              midiOutMsg.sysexBytes = sysexWasm.slice().buffer;
            }
            self.port.postMessage(midiOutMsg);
            state.lastSentMidiHeads[i] = currentHead;
            state.lastSentMidiOverflows[i] = currentOverflow;
          }
        } else {
          // in port = expose the WASM drain tail to main / notify overflow
          if (isSab && state.midiRingsBuffer !== null) {
            Atomics.store(state.midiRingsSabHeaderViews[i]!, 1, wasmH[1]!);
          } else {
            const currentOverflow = wasmH[2]!;
            if (currentOverflow !== state.lastSentMidiInOverflows[i]) {
              self.port.postMessage({
                kind: "midi-overflow",
                ringIndex: i,
                overflowCount: currentOverflow,
              });
              state.lastSentMidiInOverflows[i] = currentOverflow;
            }
          }
        }
      }
    }

    return true;
  };

  return {
    initialize,
    process,
    parameterDescriptors,
    inputs: inputDescriptors,
    outputs: outputDescriptors,
    publishSlots,
    eventRings,
    messageRings,
    midiRings,
  };
}
