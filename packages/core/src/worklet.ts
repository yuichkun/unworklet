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
import { EGRESS_HEADER_BYTES, EGRESS_SECTION_HEADER_BYTES, alignUp4 } from "./egressFrame.ts";
import { atomicMonotoneMax, ringCount, ringLeads, ringSlotIndex } from "./ringIndex.ts";
import { bindSabIngress, consumeSabIngress, type SabIngressRing } from "./sabIngress.ts";
import { checkRingHeader } from "./selfcheck.ts";

/**
 * Debug-only audio-thread invariant monitor (Layer F). Injected by the unplugin
 * (`true` in serve, `false` in build) and tree-shaken from production; left
 * `undefined` in node tests with no plugin, where a test can set it on the
 * global to exercise the self-check.
 */
declare const __UNWORKLET_SELFCHECK__: boolean;
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
  readonly egressAccess: Int32Array | null;
  readonly ingressAccess: Int32Array | null;
  readonly messageIngressShared: readonly SabIngressRing[];
  readonly messageIngressWasm: readonly SabIngressRing[];
  readonly midiIngressShared: ReadonlyArray<SabIngressRing | null>;
  readonly midiIngressWasm: ReadonlyArray<SabIngressRing | null>;
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
   * postMessage-path egress buffer pool (see `egressFrame.ts` for the wire
   * format and the ownership ping-pong). Buffers arrive from main via
   * `{ kind: 'egress-buffer' }` (initial seed) and `{ kind: 'egress-recycle' }`
   * (returned after consumption, carrying consumed-tail acks); the per-quantum
   * egress pops one, encodes the frame, and transfers it back. Views are bound
   * in the port handler and reused by the egress encoder during process().
   * Receiving and recycling buffers can allocate. Empty on the SAB path.
   */
  readonly egressPool: Array<{ buffer: ArrayBuffer; dv: DataView; u8: Uint8Array }>;
  /**
   * The egress `postMessage` envelope and its transfer list, bound once and
   * rewritten in place per post. Built inside process(), the object literal and
   * the one-element array would be two escaping allocations every quantum that
   * carries egress — small, but handed to the collector at audio rate. The
   * transport structured-clones the envelope before `postMessage` returns, so a
   * delivered message never sees the next quantum's rewrite. Unused on the SAB
   * path (the shared views carry the data instead).
   */
  readonly egressMessage: { kind: "egress"; buffer: ArrayBuffer | null; byteLength: number };
  readonly egressTransfer: Transferable[];
  readonly messageRingsBuffer: SharedArrayBuffer | ArrayBuffer | null;
  readonly messageRings: readonly MessageRingSlotDescriptor[];
  readonly messageRingsWasmDataViews: readonly DataView[];
  readonly messageRingsWasmHeaderViews: readonly Int32Array[];
  readonly messageContentWasmViews: ReadonlyArray<Uint8Array | null>;
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
  port: { postMessage: (m: unknown, transfer?: Transferable[]) => void };
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
    egressAccessBuffer?: SharedArrayBuffer | ArrayBuffer;
    ingressAccessBuffer?: SharedArrayBuffer | ArrayBuffer;
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

/**
 * postMessage-path egress: encode one quantum's worklet→main ring news (event
 * rings + MIDI out rings) into a pooled transferable frame and post it. See
 * `egressFrame.ts` for the wire format and the ownership ping-pong.
 *
 * Allocation-free by construction: the frame buffer and its views come
 * pre-bound from the pool (bound in the port handler when main seeded /
 * recycled them), the message envelope and its transfer list are bound at
 * initialize and rewritten in place, slot bytes are copied with plain byte
 * loops (a `subarray` per slot would allocate a view object), and with no news
 * — or no free buffer — nothing is taken and nothing is sent. A starved quantum
 * leaves the `lastSent*` anchors unchanged, so the data stays in the WASM rings
 * (bounded by drop-oldest) and rides a later quantum's frame.
 *
 * The transport still allocates in this realm on the RECEIVE side, which no
 * design here can remove: delivering a message constructs its data object, and
 * a transferred buffer arrives as a fresh ArrayBuffer identity whose two views
 * must be rebound (see the `egress-buffer` / `egress-recycle` handler). What
 * the pool removes is everything that SCALES — the per-quantum frame buffer and
 * the per-slot copies. This is the fallback for realms without a
 * SharedArrayBuffer, where the primary path exchanges no messages at all.
 */
function postEgressFrame(self: SelfWithState, state: WorkletState): void {
  const eventRings = state.eventRings;
  const midiRings = state.midiRings;
  let news = false;
  for (let i = 0; i < eventRings.length && !news; i++) {
    const wasmH = state.eventRingsWasmHeaderViews[i]!;
    if (
      wasmH[0]! !== state.lastSentEventHeads[i]! ||
      wasmH[2]! !== state.lastSentEventOverflows[i]!
    )
      news = true;
  }
  for (let i = 0; i < midiRings.length && !news; i++) {
    if (midiRings[i]!.direction !== "out") continue;
    const wasmH = state.midiRingsWasmHeaderViews[i]!;
    if (wasmH[0]! !== state.lastSentMidiHeads[i]! || wasmH[2]! !== state.lastSentMidiOverflows[i]!)
      news = true;
  }
  if (!news) return;
  const entry = state.egressPool.pop();
  if (entry === undefined) return;
  const { dv, u8 } = entry;
  let cursor = EGRESS_HEADER_BYTES;
  let eventSections = 0;
  for (let i = 0; i < eventRings.length; i++) {
    const ring = eventRings[i]!;
    const wasmH = state.eventRingsWasmHeaderViews[i]!;
    const head = wasmH[0]!;
    const tail = wasmH[1]!;
    const overflow = wasmH[2]!;
    if (head === state.lastSentEventHeads[i] && overflow === state.lastSentEventOverflows[i])
      continue;
    // drop-oldest may have advanced tail past the last sent head — re-anchor
    // to whichever leads (serial order; the overflowed slots are already gone).
    const lastSent = state.lastSentEventHeads[i]!;
    const from = ringLeads(tail, lastSent) ? tail : lastSent;
    const newSlotCount = ringCount(head, from);
    const contentWasm = state.eventContentWasmViews[i];
    const contentLen = contentWasm !== null && newSlotCount > 0 ? contentWasm.byteLength : 0;
    dv.setUint32(cursor, i, true);
    dv.setInt32(cursor + 4, head, true);
    dv.setUint32(cursor + 8, newSlotCount, true);
    dv.setInt32(cursor + 12, overflow, true);
    dv.setUint32(cursor + 16, contentLen, true);
    cursor += EGRESS_SECTION_HEADER_BYTES;
    const wasmRawView = state.eventRingsWasmViews[i]!;
    const slotSize = ring.slotSize;
    for (let k = 0; k < newSlotCount; k++) {
      const slotIdx = ringSlotIndex(from + k, ring.capacity);
      const srcOffset = 12 + slotIdx * slotSize;
      const dstOffset = cursor + k * slotSize;
      // Byte loop, not `.set(subarray(...))` — a subarray allocates a view.
      for (let b = 0; b < slotSize; b++) u8[dstOffset + b] = wasmRawView[srcOffset + b]!;
    }
    cursor += newSlotCount * slotSize;
    if (contentLen > 0) {
      u8.set(contentWasm!, cursor);
    }
    cursor = alignUp4(cursor + contentLen);
    state.lastSentEventHeads[i] = head;
    state.lastSentEventOverflows[i] = overflow;
    eventSections++;
  }
  let midiSections = 0;
  for (let i = 0; i < midiRings.length; i++) {
    const ring = midiRings[i]!;
    if (ring.direction !== "out") continue;
    const wasmH = state.midiRingsWasmHeaderViews[i]!;
    const head = wasmH[0]!;
    const tail = wasmH[1]!;
    const overflow = wasmH[2]!;
    if (head === state.lastSentMidiHeads[i] && overflow === state.lastSentMidiOverflows[i])
      continue;
    const lastSent = state.lastSentMidiHeads[i]!;
    const from = ringLeads(tail, lastSent) ? tail : lastSent;
    const newSlotCount = ringCount(head, from);
    const sysexWasm = state.sysexContentWasmViews[i];
    const sysexLen = sysexWasm !== null && newSlotCount > 0 ? sysexWasm.byteLength : 0;
    dv.setUint32(cursor, i, true);
    dv.setInt32(cursor + 4, head, true);
    dv.setUint32(cursor + 8, newSlotCount, true);
    dv.setInt32(cursor + 12, overflow, true);
    dv.setUint32(cursor + 16, sysexLen, true);
    cursor += EGRESS_SECTION_HEADER_BYTES;
    const wasmRawView = state.midiRingsWasmViews[i]!;
    for (let k = 0; k < newSlotCount; k++) {
      const slotIdx = ringSlotIndex(from + k, ring.capacity);
      const srcOffset = 12 + slotIdx * MIDI_SLOT_BYTES;
      const dstOffset = cursor + k * MIDI_SLOT_BYTES;
      // Byte loop, not `.set(subarray(...))` — a subarray allocates a view.
      for (let b = 0; b < MIDI_SLOT_BYTES; b++) u8[dstOffset + b] = wasmRawView[srcOffset + b]!;
    }
    cursor += newSlotCount * MIDI_SLOT_BYTES;
    if (sysexLen > 0) {
      u8.set(sysexWasm!, cursor);
    }
    cursor = alignUp4(cursor + sysexLen);
    state.lastSentMidiHeads[i] = head;
    state.lastSentMidiOverflows[i] = overflow;
    midiSections++;
  }
  dv.setUint32(0, eventSections, true);
  dv.setUint32(4, midiSections, true);
  // Rewrite the pre-bound envelope + transfer list rather than building them:
  // postMessage clones synchronously, so the delivered message keeps this
  // quantum's values while the next post reuses the same two objects.
  const message = state.egressMessage;
  message.buffer = entry.buffer;
  message.byteLength = cursor;
  state.egressTransfer[0] = entry.buffer;
  self.port.postMessage(message, state.egressTransfer);
}

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
      const egressPool: Array<{ buffer: ArrayBuffer; dv: DataView; u8: Uint8Array }> = [];
      // Bound here, off the hot path: process() rewrites these two in place
      // rather than building a fresh envelope + transfer list per quantum.
      const egressMessage: {
        kind: "egress";
        buffer: ArrayBuffer | null;
        byteLength: number;
      } = { kind: "egress", buffer: null, byteLength: 0 };
      const egressTransfer: Transferable[] = [];
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

      // SAB ownership covers copying; the WASM ring retains entries until its handler drains them.
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
      const messageContentWasmViews: Array<Uint8Array | null> = [];
      const messageContentSabViews: Array<Uint8Array | null> = [];
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
      const egressAccessBuffer = opts.processorOptions?.egressAccessBuffer ?? null;
      if (
        transport === "sab" &&
        (eventRingsBuffer !== null ||
          (midiRingsBuffer !== null && midiRingsMeta.some((ring) => ring.direction === "out"))) &&
        (egressAccessBuffer === null ||
          egressAccessBuffer.byteLength < (eventRings.length + midiRingsMeta.length) * 4)
      ) {
        throw new Error("unworklet: SAB out-rings require an egress access word for each ring");
      }
      const egressAccess = egressAccessBuffer === null ? null : new Int32Array(egressAccessBuffer);
      const ingressAccessBuffer = opts.processorOptions?.ingressAccessBuffer ?? null;
      if (
        transport === "sab" &&
        (messageRingsBuffer !== null ||
          (midiRingsBuffer !== null && midiRingsMeta.some((ring) => ring.direction === "in"))) &&
        (ingressAccessBuffer === null ||
          ingressAccessBuffer.byteLength < (messageRings.length + midiRingsMeta.length) * 4)
      ) {
        throw new Error("unworklet: SAB in-rings require an ingress access word for each ring");
      }
      const ingressAccess =
        ingressAccessBuffer === null ? null : new Int32Array(ingressAccessBuffer);
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

      const messageIngressShared = messageRingsSabViews.map((bytes, i) =>
        bindSabIngress(
          bytes,
          messageContentSabViews[i]!,
          messageRings[i]!.capacity,
          (messageRings[i]!.fields.find((field) => field.payloadElementType !== undefined)
            ?.offsetInSlot ?? -5) + 4,
          false,
        ),
      );
      const messageIngressWasm = messageIngressShared.map((shared, i) =>
        bindSabIngress(
          messageRingsWasmViews[i]!,
          messageContentWasmViews[i]!,
          shared.capacity,
          shared.contentOffset,
          false,
        ),
      );
      const midiIngressShared = midiRingsSabViews.map((bytes, i) =>
        midiRingsMeta[i]!.direction === "out"
          ? null
          : bindSabIngress(bytes, sysexContentSabViews[i]!, midiRingsMeta[i]!.capacity, -1, true),
      );
      const midiIngressWasm = midiIngressShared.map((shared, i) =>
        shared === null
          ? null
          : bindSabIngress(
              midiRingsWasmViews[i]!,
              sysexContentWasmViews[i]!,
              shared.capacity,
              -1,
              true,
            ),
      );

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
        egressAccess,
        ingressAccess,
        messageIngressShared,
        messageIngressWasm,
        midiIngressShared,
        midiIngressWasm,
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
        egressPool,
        egressMessage,
        egressTransfer,
        messageRingsBuffer,
        messageRings,
        messageRingsWasmDataViews,
        messageRingsWasmHeaderViews,
        messageContentWasmViews,
        messageQueueMirrors,
        lastSentMessageOverflows,
        midiRingsBuffer,
        midiRings: midiRingsMeta,
        midiRingsWasmViews,
        midiWasmDataView,
        midiRingsWasmHeaderViews,
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

      // Minimum pool-buffer size for this node's worst-case egress frame
      // (`egressFrame.ts`), computed against the SAME views the encoder reads.
      // An undersized buffer arriving on the port (malformed or foreign
      // message) is rejected at the boundary — accepting it would let
      // `postEgressFrame` overrun the DataView mid-quantum.
      let egressFrameBytes = EGRESS_HEADER_BYTES;
      for (let i = 0; i < eventRings.length; i++) {
        egressFrameBytes +=
          EGRESS_SECTION_HEADER_BYTES +
          eventRings[i]!.capacity * eventRings[i]!.slotSize +
          alignUp4(eventContentWasmViews[i]?.byteLength ?? 0);
      }
      for (let i = 0; i < midiRingsMeta.length; i++) {
        if (midiRingsMeta[i]!.direction !== "out") continue;
        egressFrameBytes +=
          EGRESS_SECTION_HEADER_BYTES +
          midiRingsMeta[i]!.capacity * MIDI_SLOT_BYTES +
          alignUp4(sysexContentWasmViews[i]?.byteLength ?? 0);
      }

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
          const off = lay.regions.states.slots[s.name]!;
          out.push({
            name: s.name,
            kind: "state",
            type: s.type,
            data: new Uint8Array(buf.slice(off, off + SNAPSHOT_ELEMENT_BYTES[s.type]!)),
          });
        }
        for (const b of meta.buffers) {
          if (b.userNamed !== true || !isPersistent(b.snapshot, "transient", profile)) continue;
          const off = lay.regions.buffers.slots[b.name]!;
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
          const off = lay.regions.states.slots[s.name]!;
          out.push({
            name: s.name,
            kind: "state",
            type: s.type,
            data: new Uint8Array(buf.slice(off, off + SNAPSHOT_ELEMENT_BYTES[s.type]!)),
          });
        }
        for (const b of meta.buffers) {
          const off = lay.regions.buffers.slots[b.name]!;
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
                buffer?: unknown;
                eventTails?: unknown;
                midiTails?: unknown;
              }
            | null
            | undefined;
          if (typeof data !== "object" || data === null) return;
          if (data.kind === "egress-buffer" || data.kind === "egress-recycle") {
            // A pool buffer arriving from main — the initial seed, or a frame
            // coming back after consumption (`egressFrame.ts`). Views are bound
            // HERE, in the port handler: a transferred-back ArrayBuffer is a
            // fresh identity. The egress encoder reuses these views during
            // process(); receiving the buffer and creating views can allocate.
            // Undersized buffers
            // are rejected — the encoder sizes against `egressFrameBytes` and
            // never bounds-checks in the hot path.
            if (data.buffer instanceof ArrayBuffer && data.buffer.byteLength >= egressFrameBytes) {
              egressPool.push({
                buffer: data.buffer,
                dv: new DataView(data.buffer),
                u8: new Uint8Array(data.buffer),
              });
            }
            if (data.kind === "egress-recycle") {
              // Consumed-tail acknowledgements — the consumer→producer feedback
              // of the postMessage path (the SAB path reads the shared tail
              // word instead). Serial-order guarded: the WASM drop-oldest also
              // advances these words, so they only ever move forward.
              if (Array.isArray(data.eventTails)) {
                for (const pair of data.eventTails) {
                  if (!Array.isArray(pair)) continue;
                  const [idx, tail] = pair as [unknown, unknown];
                  if (typeof idx !== "number" || typeof tail !== "number") continue;
                  if (idx < 0 || idx >= eventRings.length) continue;
                  const wasmH = eventRingsWasmHeaderViews[idx]!;
                  if (ringLeads(tail, wasmH[1]!)) wasmH[1] = tail;
                }
              }
              if (Array.isArray(data.midiTails)) {
                for (const pair of data.midiTails) {
                  if (!Array.isArray(pair)) continue;
                  const [idx, tail] = pair as [unknown, unknown];
                  if (typeof idx !== "number" || typeof tail !== "number") continue;
                  if (idx < 0 || idx >= midiRingsMeta.length) continue;
                  if (midiRingsMeta[idx]!.direction !== "out") continue;
                  const wasmH = midiRingsWasmHeaderViews[idx]!;
                  if (ringLeads(tail, wasmH[1]!)) wasmH[1] = tail;
                }
              }
            }
            return;
          }
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
              // Render-health counter (issue #27): output samples the non-finite
              // scrub replaced with 0, read from the exported WASM global. Rides
              // the dump so a live node can be asked the same question a render
              // answers through `renderOffline(...).diagnostics`; the main side
              // hands it back as part of `devDump()`.
              scrubbedSamples: (instance.exports["scrubbedSamples"] as WebAssembly.Global)
                .value as number,
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

    if (state.messageRings.length > 0) {
      const isSab = state.transport === "sab";
      if (isSab && state.messageRingsBuffer !== null) {
        for (let i = 0; i < state.messageIngressShared.length; i++) {
          consumeSabIngress(
            state.ingressAccess!,
            i,
            state.messageIngressShared[i]!,
            state.messageIngressWasm[i]!,
          );
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
                  const perSlot = contentWasm.byteLength / capacity;
                  const copyBytes = Math.min(value.byteLength, perSlot);
                  const cursor = ringSlotIndex(head, capacity) * perSlot;
                  const src = new Uint8Array(value.buffer, value.byteOffset, copyBytes);
                  contentWasm.set(src, cursor);
                  wasmDataView.setUint32(byteOffset, copyBytes, true);
                  wasmDataView.setUint32(byteOffset + 4, cursor, true);
                }
              } else if (typeof value === "number" || typeof value === "boolean") {
                // Inbound scalar field, encoded faithfully by its per-field wire type
                // (the SSoT sealed at capture): a declared `number` → f32 (its
                // fraction survives), a declared `boolean` → bool (i32 0/1).
                switch (field.wireType) {
                  case "bool":
                    wasmDataView.setInt32(byteOffset, value ? 1 : 0, true);
                    break;
                  case "i32":
                    wasmDataView.setInt32(byteOffset, Number(value) | 0, true);
                    break;
                  default:
                    wasmDataView.setFloat32(byteOffset, Number(value), true);
                    break;
                }
              }
            }
            wasmH[0] = head + 1;
          }
          queue.length = 0;
        }
      }
    }

    if (state.midiRings.length > 0) {
      const isSab = state.transport === "sab";
      const dv = state.midiWasmDataView!;
      for (let i = 0; i < state.midiRings.length; i++) {
        const ring = state.midiRings[i]!;
        if (ring.direction !== "in") continue;
        const wasmH = state.midiRingsWasmHeaderViews[i]!;
        if (isSab && state.midiRingsBuffer !== null) {
          consumeSabIngress(
            state.ingressAccess!,
            state.messageRings.length + i,
            state.midiIngressShared[i]!,
            state.midiIngressWasm[i]!,
          );
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
              dv.setUint16(ring.wasmRingBase + slotByteOffset + 1, chunkIdx, true);
              dv.setUint8(ring.wasmRingBase + slotByteOffset + 3, 0);
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

    // Consumer→producer tail feedback for the worklet→main rings. Main commits
    // how far it drained into the SAB tail word (monotone-max on its side);
    // mirror that into the WASM header BEFORE process() so the WASM-side
    // `head - tail >= capacity` overflow check sees real ring occupancy.
    // Without this the WASM tail only ever advances via drop-oldest, so the
    // check saturates after `capacity` lifetime emits and every later emit
    // false-fires drop-oldest with a lying overflowCount. Serial-order guarded
    // (`ringLeads`): the WASM drop-oldest also moves this word, so it only
    // ever moves forward.
    if (state.transport === "sab") {
      if (state.eventRingsBuffer !== null) {
        const wasmHeaders = state.eventRingsWasmHeaderViews;
        const sabHeaders = state.eventRingsSabHeaderViews;
        for (let i = 0; i < wasmHeaders.length; i++) {
          const wasmH = wasmHeaders[i]!;
          const consumed = Atomics.load(sabHeaders[i]!, 1);
          if (ringLeads(consumed, wasmH[1]!)) wasmH[1] = consumed;
        }
      }
      if (state.midiRingsBuffer !== null) {
        for (let i = 0; i < state.midiRings.length; i++) {
          if (state.midiRings[i]!.direction !== "out") continue;
          const wasmH = state.midiRingsWasmHeaderViews[i]!;
          const consumed = Atomics.load(state.midiRingsSabHeaderViews[i]!, 1);
          if (ringLeads(consumed, wasmH[1]!)) wasmH[1] = consumed;
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

    // event ring copy — SAB path: slot-region bulk copy (NOT the header) +
    // header Atomics commits. The postMessage path is handled by the pooled
    // egress frame below, shared with the MIDI out rings (`egressFrame.ts`).
    if (
      state.eventRings.length > 0 &&
      state.transport === "sab" &&
      state.eventRingsBuffer !== null
    ) {
      const sabSlotViews = state.eventRingsSabSlotViews;
      const wasmSlotViews = state.eventRingsWasmSlotViews;
      const wasmHeaders = state.eventRingsWasmHeaderViews;
      const sabHeaders = state.eventRingsSabHeaderViews;
      for (let i = 0; i < state.eventRings.length; i++) {
        const access = state.egressAccess!;
        // A busy reader owns a complete snapshot in progress. Keep the WASM
        // backlog for another quantum; the audio thread never waits for main.
        if (Atomics.compareExchange(access, i, 0, 1) !== 0) continue;
        try {
          const wasmH = wasmHeaders[i]!;
          const currentHead = wasmH[0]!;
          const currentTail = wasmH[1]!;
          const currentOverflow = wasmH[2]!;
          sabSlotViews[i]!.set(wasmSlotViews[i]!);
          const contentWasm = state.eventContentWasmViews[i];
          const contentSab = state.eventContentSabViews[i];
          if (contentWasm !== null && contentSab !== null) contentSab.set(contentWasm);
          const sabH = sabHeaders[i]!;
          atomicMonotoneMax(sabH, 1, currentTail);
          Atomics.store(sabH, 2, currentOverflow);
          Atomics.store(sabH, 0, currentHead);
        } finally {
          Atomics.store(access, i, 0);
        }
      }
    }

    if (state.transport !== "sab") {
      for (let i = 0; i < state.messageRingsWasmHeaderViews.length; i++) {
        const currentOverflow = state.messageRingsWasmHeaderViews[i]![2]!;
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

    if (state.midiRings.length > 0) {
      const isSab = state.transport === "sab";
      for (let i = 0; i < state.midiRings.length; i++) {
        const ring = state.midiRings[i]!;
        const wasmH = state.midiRingsWasmHeaderViews[i]!;
        if (ring.direction === "out") {
          // SAB path only — the postMessage path rides the pooled egress frame
          // below, shared with the event rings (`egressFrame.ts`).
          if (isSab && state.midiRingsBuffer !== null) {
            const access = state.egressAccess!;
            const accessIndex = state.eventRings.length + i;
            if (Atomics.compareExchange(access, accessIndex, 0, 1) !== 0) continue;
            try {
              const currentHead = wasmH[0]!;
              const currentTail = wasmH[1]!;
              const currentOverflow = wasmH[2]!;
              state.midiRingsSabSlotViews[i]!.set(state.midiRingsWasmSlotViews[i]!);
              const sysexWasm = state.sysexContentWasmViews[i];
              const sysexSab = state.sysexContentSabViews[i];
              if (sysexWasm !== null && sysexSab !== null) sysexSab.set(sysexWasm);
              const sabH = state.midiRingsSabHeaderViews[i]!;
              atomicMonotoneMax(sabH, 1, currentTail);
              Atomics.store(sabH, 2, currentOverflow);
              Atomics.store(sabH, 0, currentHead);
            } finally {
              Atomics.store(access, accessIndex, 0);
            }
          }
        } else {
          if (!isSab) {
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

    // postMessage egress: one pooled transferable frame per quantum carrying
    // every worklet→main ring's news (event + MIDI out). See `egressFrame.ts`
    // and `postEgressFrame` for the wire format and the no-allocation shape.
    // The publish / *-overflow notifications above stay as small standalone
    // posts: they are edge-triggered and rate-bounded (a changed value at most
    // per rateFps / per overflow change), not per-quantum data-plane traffic.
    if (state.transport !== "sab") {
      postEgressFrame(self, state);
    }

    // Layer F: debug-only invariant monitor. Every quantum, assert each SAB ring
    // header is sane (no overfill, no tail rewind, no negative overflow) and
    // surface any corruption to main the instant it happens. The whole block is
    // gated behind a define that is `false` in production and tree-shaken away,
    // so prod stays byte-identical.
    if (typeof __UNWORKLET_SELFCHECK__ !== "undefined" && __UNWORKLET_SELFCHECK__ === true) {
      const audit = (
        headers: readonly Int32Array[],
        rings: ReadonlyArray<{ readonly capacity: number }>,
        kind: string,
      ): void => {
        for (let i = 0; i < headers.length; i++) {
          const h = headers[i]!;
          const violation = checkRingHeader(h[0]!, h[1]!, h[2]!, rings[i]!.capacity);
          if (violation !== null) {
            self.port.postMessage({
              kind: "selfcheck-violation",
              ring: `${kind}[${i}]`,
              detail: violation,
            });
          }
        }
      };
      audit(state.eventRingsWasmHeaderViews, state.eventRings, "event");
      audit(state.messageRingsWasmHeaderViews, state.messageRings, "message");
      audit(state.midiRingsWasmHeaderViews, state.midiRings, "midi");
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
