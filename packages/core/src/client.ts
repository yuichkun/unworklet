/**
 * Main-thread client surface (`05-client.md` §1 + §2).
 *
 * - `createNode(context, processor, options?)` — takes the `CompiledProcessor`
 *   augmented via `?worklet` and returns a typed `UnworkletNode<C>` after
 *   `addModule` + `fetch(wasmUrl)` + `new AudioWorkletNode(...)` + the readiness
 *   handshake. `audioWorklet.addModule` is cached per (context, moduleUrl) to
 *   prevent double registration.
 * - `UnworkletNode<C>` full surface = `node` / `inputs.<name>` /
 *   `outputs.<name>` / `params.<name>` / `state` / `events` / `messages` /
 *   `midi` / `snapshot` / `restore` / `onError` / `diagnostics` / `dispose()`.
 * - `inspect(blob)` — non-realtime free function (Q48); needs no `AudioContext`.
 */

import type {
  AudioPortDescriptor,
  BufferElementType,
  CompiledProcessor,
  CreateNodeOptions,
  EventSurface,
  InspectionResult,
  MidiEvent,
  MidiEventType,
  MidiPortSurface,
  NodeErrorEvent,
  ScalarType,
  StateValueProxy,
  UnworkletNode,
} from "./types.ts";
import { midiEventToWire, wireToMidiEvent } from "./midiWire.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { decodeScalar, type SnapshotSlot } from "./snapshot.ts";
import { decodeSnapshot, encodeSnapshot, inspectSnapshot, runMigrations } from "./snapshotBlob.ts";
import type { RestoreResult } from "./types.ts";
import { type DevNodeHandle, registerDevNode, unregisterDevNode } from "./devRegistry.ts";

// Dev-only gate (DevTools integration §4): the Vite plugin defines this as
// `true` in serve mode and `false` in build, so production tree-shakes the
// registry wiring. In source / tests it is an undeclared global until set on
// `globalThis`, hence the `typeof` guard at each use site.
declare const __UNWORKLET_DEVTOOLS__: boolean;

/**
 * Convert an i32 bit pattern in the publishShared region into its user-surface
 * type. `f32` reinterprets the bit pattern through a Float32Array, `bool` maps
 * 0/1 → boolean, `i32` passes through unchanged. Per Q42 the publishable types
 * are limited to f32 / i32 / bool, so this function covers every path. These
 * module-level temps are allocated once and reused: the main thread is outside
 * the audio-thread no-alloc invariant, but holding a shared buffer still avoids
 * per-call allocation under heavy polling.
 */
const F32_REINTERPRET_BUF = new ArrayBuffer(4);
const F32_REINTERPRET_FLOAT = new Float32Array(F32_REINTERPRET_BUF);
const F32_REINTERPRET_INT = new Int32Array(F32_REINTERPRET_BUF);

/**
 * Read a per-field value out of an event ring slot and reinterpret it as a
 * plain JS value. `wireType` is the type sealed at the first emit (Q71); on the
 * main thread the value is exposed as a plain JS value (number / boolean /
 * bigint) — the `Node<T>` form in `EmitPayload` exists only on the worklet
 * side, the main thread sees natural JS.
 */
function readEventFieldValue(
  view: DataView,
  byteOffset: number,
  wireType: ScalarType,
): number | boolean | bigint {
  switch (wireType) {
    case "i32":
      return view.getInt32(byteOffset, true);
    case "f32":
      return view.getFloat32(byteOffset, true);
    case "f64":
      return view.getFloat64(byteOffset, true);
    case "i64":
      return view.getBigInt64(byteOffset, true);
    case "bool":
      return view.getInt32(byteOffset, true) !== 0;
  }
}

/**
 * §4.3 — reinterpret the content bytes of a typed-array event field into a
 * fresh typed array of the matching element type (worklet→main; the main side
 * gets a natural JS typed array). `bytes` is copied via `slice` into a
 * non-shared, 0-aligned ArrayBuffer before a view is placed over it.
 */
function sliceTypedArray(bytes: Uint8Array, elementType: BufferElementType): ArrayBufferView {
  const copy = bytes.slice();
  switch (elementType) {
    case "f64":
      return new Float64Array(copy.buffer);
    case "u8":
      return copy;
    case "i32":
    case "bool":
      return new Int32Array(copy.buffer);
    case "i64":
      return new BigInt64Array(copy.buffer);
    case "f32":
      return new Float32Array(copy.buffer);
  }
}

function convertStateValue(bits: number, type: ScalarType): number | boolean {
  if (type === "f32") {
    F32_REINTERPRET_INT[0] = bits;
    return F32_REINTERPRET_FLOAT[0]!;
  }
  if (type === "bool") {
    return bits !== 0;
  }
  return bits; // i32 / anything else = pass through (per Q42 publishable types are limited to f32 / i32 / bool)
}

// Per-context `addModule` deduplication. The cache stores the in-flight (or
// settled) Promise itself, NOT just a "registered" flag — concurrent
// `createNode()` calls for the same `(context, moduleUrl)` would otherwise
// both miss the cache during the addModule round-trip and both call
// `audioWorklet.addModule(...)`, which then hits `registerProcessor()` twice
// with the same name (= MDN: duplicate name throws `NotSupportedError`).
const moduleCache = new WeakMap<object, Map<string, Promise<void>>>();

const addModuleOnce = (
  context: { audioWorklet: { addModule: (url: string) => Promise<void> } },
  url: string,
): Promise<void> => {
  const key = context as unknown as object;
  let perContext = moduleCache.get(key);
  if (!perContext) {
    perContext = new Map();
    moduleCache.set(key, perContext);
  }
  const existing = perContext.get(url);
  if (existing) return existing;
  // Drop a rejected entry so a subsequent call can retry (= a transient
  // network blip should not permanently poison this (context, url)).
  const promise = context.audioWorklet.addModule(url).catch((err: unknown) => {
    perContext!.delete(url);
    throw err;
  });
  perContext.set(url, promise);
  return promise;
};

/**
 * Fetch WASM bytes + asynchronously compile to a `WebAssembly.Module` on
 * the main thread. The compiled `Module` is structured-clone-safe (= W3C
 * wasm-web-api spec) and is what we hand off via
 * `AudioWorkletNodeOptions.processorOptions.module`, so the audio thread
 * only has to `new WebAssembly.Instance(module)` (= fast, deterministic
 * cost) instead of a sync `new WebAssembly.Module(bytes)` (= MDN
 * explicitly recommends the async path for production). First-quantum
 * glitch potential disappears + Chrome's 4KB sync-compile reject path is
 * sidestepped entirely.
 */
const fetchAndCompileWasm = async (url: string): Promise<WebAssembly.Module> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `unworklet: fetch(${JSON.stringify(url)}) for WASM bytes failed: ${response.status} ${response.statusText}`,
    );
  }
  // Use `WebAssembly.compileStreaming` when the response is the
  // `application/wasm` MIME — it skips the intermediate ArrayBuffer
  // copy in conformant browsers. Fall back to `WebAssembly.compile`
  // with the buffer for other content types / older engines.
  const ct = response.headers?.get?.("Content-Type") ?? "";
  if (typeof WebAssembly.compileStreaming === "function" && /application\/wasm\b/.test(ct)) {
    return await WebAssembly.compileStreaming(response);
  }
  const bytes = await response.arrayBuffer();
  return await WebAssembly.compile(bytes);
};

/**
 * Build per-`audioInput` AudioNode destinations. Each port gets a
 * pass-through `GainNode(gain=1)` pre-wired to the underlying
 * `AudioWorkletNode` at the correct input port index. Users write
 * `source.connect(node.inputs.main)` and Web Audio routes the signal through
 * the gain proxy onto the right worklet input port — no wrapper / monkey
 * patching is in the path, just standard `AudioNode.connect(...)`.
 *
 * Returned array is index-aligned with `inputs` so `dispose()` can tear
 * down each gain proxy with one pass.
 */
const buildInputProxies = (
  context: BaseAudioContext,
  node: AudioWorkletNode,
  inputs: readonly AudioPortDescriptor[],
): { handles: Record<string, AudioNode>; proxies: GainNode[] } => {
  const handles: Record<string, AudioNode> = {};
  const proxies: GainNode[] = [];
  for (let portIdx = 0; portIdx < inputs.length; portIdx++) {
    const desc = inputs[portIdx]!;
    const gain = context.createGain();
    gain.gain.value = 1;
    gain.connect(node, 0, portIdx);
    handles[desc.name] = gain;
    proxies.push(gain);
  }
  return { handles, proxies };
};

const buildOutputs = (
  node: AudioWorkletNode,
  outputs: readonly AudioPortDescriptor[],
): Record<string, { connect(target: AudioNode | AudioParam): void; disconnect(): void }> => {
  const result: Record<
    string,
    { connect(target: AudioNode | AudioParam): void; disconnect(): void }
  > = {};
  for (let portIdx = 0; portIdx < outputs.length; portIdx++) {
    const desc = outputs[portIdx]!;
    const idx = portIdx;
    result[desc.name] = {
      connect(target: AudioNode | AudioParam): void {
        // AudioWorkletNode.connect has overloads for AudioNode (= 3-arg)
        // and AudioParam (= 2-arg) destinations. AudioNode exposes a
        // `connect` method, AudioParam does not = duck-type discriminate
        // rather than `instanceof AudioNode` (avoids relying on globals
        // for offline / test environments).
        if (typeof (target as { connect?: unknown }).connect === "function") {
          node.connect(target as AudioNode, idx, 0);
        } else {
          node.connect(target as AudioParam, idx);
        }
      },
      disconnect(): void {
        node.disconnect(idx);
      },
    };
  }
  return result;
};

const buildParams = (
  node: AudioWorkletNode,
  params: readonly { name: string }[],
): Record<string, AudioParam> => {
  const result: Record<string, AudioParam> = {};
  for (const p of params) {
    const got = node.parameters.get(p.name);
    if (got) result[p.name] = got;
  }
  return result;
};

/**
 * Default timeout (ms) for the `createNode` ready handshake. Triggers a
 * reject if the worklet never posts `{ kind: "ready" }` or `{ kind:
 * "init-error" }` — last-resort safety net for cases the structured paths
 * miss (= bug in the worklet template, message dropped, etc.).
 */
const READY_TIMEOUT_MS = 10_000;

const awaitReady = (node: AudioWorkletNode): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    // `cleanup()` runs exactly once per settle path — it synchronously
    // removes both event listeners and clears the timer, so once it runs
    // the corresponding handler can no longer fire. No defensive
    // `if (settled) return` guard is needed in the handlers themselves.
    const cleanup = (): void => {
      node.port.removeEventListener("message", onMessage);
      node.removeEventListener("processorerror", onProcessorError);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { kind?: unknown; message?: unknown } | null | undefined;
      if (typeof data !== "object" || data === null) return;
      if (data.kind === "ready") {
        cleanup();
        resolve();
        return;
      }
      if (data.kind === "init-error") {
        cleanup();
        const message = typeof data.message === "string" ? data.message : "(no message)";
        reject(new Error(`unworklet: AudioWorkletProcessor initialize() failed: ${message}`));
      }
    };
    const onProcessorError = (event: Event): void => {
      cleanup();
      // `processorerror` carries no payload per MDN — surface what we can.
      const errEvent = event as ErrorEvent;
      const message = errEvent.message || "AudioWorkletProcessor constructor threw";
      reject(new Error(`unworklet: processorerror during init — ${message}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `unworklet: createNode() timed out after ${READY_TIMEOUT_MS}ms waiting for the worklet ready ack`,
        ),
      );
    }, READY_TIMEOUT_MS);
    node.port.addEventListener("message", onMessage);
    node.addEventListener("processorerror", onProcessorError);
    // Spec-compliant `MessagePort.start()` is a no-op when the port is
    // already started by `addEventListener('message', ...)` semantics, but
    // some polyfilled / older engines surface `InvalidStateError` here.
    // Wrap so the Promise rejects cleanly with cleanup instead of leaving
    // listeners + timer pinned.
    try {
      node.port.start();
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

export async function createNode<C>(
  context: BaseAudioContext,
  processor: CompiledProcessor<C>,
  options?: CreateNodeOptions<C>,
): Promise<UnworkletNode<C>> {
  const ns = processor.worklet;
  const moduleUrl = ns.moduleUrl;
  const wasmUrl = ns.wasmUrl;
  const processorName = ns.processorName;
  const displayName = ns.displayName;
  if (!moduleUrl) {
    throw new Error(
      "unworklet: createNode() requires processor.worklet.moduleUrl — import via `?worklet` or supply equivalent bundler URLs",
    );
  }
  if (!wasmUrl) {
    throw new Error(
      "unworklet: createNode() requires processor.worklet.wasmUrl — import via `?worklet` or supply equivalent bundler URLs",
    );
  }
  if (!processorName) {
    throw new Error(
      "unworklet: createNode() requires processor.worklet.processorName — import via `?worklet` or supply equivalent bundler URLs",
    );
  }

  await addModuleOnce(
    context as unknown as { audioWorklet: { addModule: (url: string) => Promise<void> } },
    moduleUrl,
  );
  const wasmModule = await fetchAndCompileWasm(wasmUrl);

  const inputs = ns.inputs;
  const outputs = ns.outputs;
  const publishSlots = ns.publishSlots;
  const eventRings = ns.eventRings;
  const messageRings = ns.messageRings;
  const midiRings = ns.midiRings;

  // Detect the transport mode. Compute transport even when publishSlots is
  // empty — the event<T> / message<T> / midi SAB ringbuffer paths reuse the
  // same transport mode, which lines up with the already-declared diagnostics
  // surface.
  const sabAvailable =
    typeof SharedArrayBuffer === "function" &&
    typeof globalThis !== "undefined" &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const transportMode: "sab" | "postMessage" = sabAvailable ? "sab" : "postMessage";

  // 12 bytes per publish slot (= 4 byte publishShared + 8 byte publishCounters).
  // Allocate only under SAB — on the postMessage path structured clone gives
  // main / worklet separate ArrayBuffer instances, so they cannot mirror; the
  // worklet notifies via port.postMessage instead, so the main side needs no
  // buffer at all.
  const publishBufferByteLength = publishSlots.length * 12;
  let publishBuffer: SharedArrayBuffer | null = null;
  if (publishBufferByteLength > 0 && sabAvailable) {
    publishBuffer = new SharedArrayBuffer(publishBufferByteLength);
  }

  // event ring buffer. Allocate only under SAB — on the postMessage path
  // structured clone gives main / worklet separate ring instances, so they
  // cannot mirror; the worklet ships each new emit individually via
  // port.postMessage, so the main side needs no buffer at all. Under SAB all
  // event rings sit contiguously in one SAB, and each ring's offset is the
  // running total in declaration order (computed identically on main / worklet).
  let eventRingsByteLength = 0;
  const eventRingSabOffsets: number[] = [];
  for (const ring of eventRings) {
    eventRingSabOffsets.push(eventRingsByteLength);
    eventRingsByteLength += 12 + ring.capacity * ring.slotSize;
  }
  let eventRingsBuffer: SharedArrayBuffer | null = null;
  if (eventRingsByteLength > 0 && sabAvailable) {
    eventRingsBuffer = new SharedArrayBuffer(eventRingsByteLength);
  }

  // §4.3 content buffer (worklet→main): for each event with a typed-array
  // field, lay out payloadContent.capacity bytes contiguously (aligned with the
  // ring index). The worklet mirrors WASM content here; the main side slices it
  // by the slot's [len, offset] during drain.
  let eventContentByteLength = 0;
  const eventContentSabOffsets: number[] = [];
  for (const ring of eventRings) {
    eventContentSabOffsets.push(eventContentByteLength);
    if (ring.payloadContent !== undefined) {
      eventContentByteLength += ring.payloadContent.capacity;
    }
  }
  let eventContentBuffer: SharedArrayBuffer | null = null;
  if (eventContentByteLength > 0 && sabAvailable) {
    eventContentBuffer = new SharedArrayBuffer(eventContentByteLength);
  }

  // message ring buffer. Allocate only under SAB — on the postMessage path the
  // main side sends directly via
  // `port.postMessage({ kind: 'message', ringIndex, payload })`, and the worklet
  // receives it in self.port.onmessage, pushes onto messageQueueMirrors, and
  // injects into the WASM ring once processing starts; the main side needs no
  // buffer at all. Under SAB it mirrors the event-ring pattern (= contiguous in
  // one SAB, with the main-side sender pushing into the SAB).
  let messageRingsByteLength = 0;
  const messageRingSabOffsets: number[] = [];
  for (const ring of messageRings) {
    messageRingSabOffsets.push(messageRingsByteLength);
    messageRingsByteLength += 12 + ring.capacity * ring.slotSize;
  }
  let messageRingsBuffer: SharedArrayBuffer | null = null;
  if (messageRingsByteLength > 0 && sabAvailable) {
    messageRingsBuffer = new SharedArrayBuffer(messageRingsByteLength);
  }

  // §5.2 variable-length content buffer: for each message with a typed-array
  // field, lay out `payloadContent.capacity` bytes contiguously (aligned with
  // the ring index; rings without content still hold an offset, and the
  // consumer keys off whether descriptor.payloadContent is present). Under SAB
  // the main side pushes the array here and the worklet mirrors it into the
  // WASM content region.
  let messageContentByteLength = 0;
  const messageContentSabOffsets: number[] = [];
  for (const ring of messageRings) {
    messageContentSabOffsets.push(messageContentByteLength);
    if (ring.payloadContent !== undefined) {
      messageContentByteLength += ring.payloadContent.capacity;
    }
  }
  let messageContentBuffer: SharedArrayBuffer | null = null;
  if (messageContentByteLength > 0 && sabAvailable) {
    messageContentBuffer = new SharedArrayBuffer(messageContentByteLength);
  }
  const messageContentCursors: number[] = messageRings.map(() => 0);

  // MIDI ring buffer (`11-midi.md` §4.4). An `in` port uses the same transport
  // as message (main → SAB / postMessage → worklet); an `out` port uses the
  // same as event (worklet → SAB / postMessage → main). Fixed 8-byte slot =
  // 12 + capacity × 8 byte. Allocate only under SAB.
  let midiRingsByteLength = 0;
  const midiRingSabOffsets: number[] = [];
  for (const ring of midiRings) {
    midiRingSabOffsets.push(midiRingsByteLength);
    midiRingsByteLength += 12 + ring.capacity * 8;
  }
  let midiRingsBuffer: SharedArrayBuffer | null = null;
  if (midiRingsByteLength > 0 && sabAvailable) {
    midiRingsBuffer = new SharedArrayBuffer(midiRingsByteLength);
  }
  // §4.3 sysex content buffer: for each sysex port, lay out perChunk × chunks
  // bytes contiguously (aligned with the ring index; ports without sysex still
  // hold an offset). Allocate only under SAB.
  let sysexContentByteLength = 0;
  const sysexContentSabOffsets: number[] = [];
  for (const ring of midiRings) {
    sysexContentSabOffsets.push(sysexContentByteLength);
    if (ring.sysex !== undefined) {
      sysexContentByteLength += ring.sysex.perChunk * ring.sysex.chunks;
    }
  }
  let sysexContentBuffer: SharedArrayBuffer | null = null;
  if (sysexContentByteLength > 0 && sabAvailable) {
    sysexContentBuffer = new SharedArrayBuffer(sysexContentByteLength);
  }
  // For an `in` port, the per-port head cursor used when main pushes into the
  // SAB ring lives in the SAB header (= head/tail manipulated via Atomics for
  // the drop-oldest decision). The per-port write cursor for sysex content is
  // determined per send by head%chunks, so no separate cursor is needed.

  // Build the main-side state surface; the path forks on transport mode:
  //
  // - SAB available: the `.value` getter on each slot does Atomics.load on
  //   publishBuffer's Int32Array view + per-type reinterpret.
  //   `.subscribe(handler)` starts the rAF polling driver, which detects
  //   version-counter advances and fires the handler.
  // - SAB unavailable: no shared buffer; on a version advance the worklet posts
  //   `port.postMessage({ kind: 'publish', slotIndex, valueBits, ... })`, and
  //   the main side receives it in port.onmessage, immediately updating internal
  //   mirror state + dispatching to subscribers (= no rAF, zero polling
  //   latency). The `.value` getter reads bits from the mirror; `.subscribe`
  //   merely adds to the subscriber set.
  const stateSurface: Record<string, StateValueProxy<unknown>> = {};
  const stateSubscribers: Map<string, Set<(value: unknown) => void>> = new Map();
  const lastSeenVersions: number[] = publishSlots.map(() => 0);
  let rafHandle: number | null = null;
  let disposed = false;
  let publishSharedView: Int32Array | null = null;
  // Internal mirror for the postMessage path (= holds valueBits / version in
  // slotIndex order, updated in port.onmessage and read by the `.value` getter /
  // dedupe diagnostic).
  const postMessageMirrorBits: number[] = publishSlots.map(() => 0);
  const postMessageMirrorVersions: number[] = publishSlots.map(() => 0);
  if (publishBuffer !== null && publishSlots.length > 0) {
    publishSharedView = new Int32Array(publishBuffer);
  }
  if (publishSlots.length > 0) {
    for (let i = 0; i < publishSlots.length; i++) {
      const slot = publishSlots[i]!;
      const valueSlotIdx = i * 3;
      const subscribers = new Set<(value: unknown) => void>();
      stateSubscribers.set(slot.name, subscribers);
      const slotIndex = i;
      stateSurface[slot.name] = {
        get value() {
          if (transportMode === "sab" && publishSharedView !== null) {
            const bits = Atomics.load(publishSharedView, valueSlotIdx);
            return convertStateValue(bits, slot.type);
          }
          // postMessage path = read from the internal mirror (= the worklet's
          // latest value, posted via port.postMessage, has already been applied
          // to the mirror in onPublishMessage).
          return convertStateValue(postMessageMirrorBits[slotIndex]!, slot.type);
        },
        subscribe(handler) {
          subscribers.add(handler);
          // SAB path = rAF polling detects version-counter advances + dispatches.
          // postMessage path = port.onmessage-driven immediate dispatch = no polling.
          if (transportMode === "sab") {
            ensureRafLoopRunning();
          }
          return () => {
            subscribers.delete(handler);
            // Stop rAF polling once every surface has zero subscribers
            // (= avoids wasting the main thread by polling every frame until
            // dispose when a node only ever sees temporary subscribe / unsubscribe).
            if (!hasAnySubscribers()) stopRafLoop();
          };
        },
      };
    }
  }

  // Build the event ring surface; the path forks on transport mode:
  //
  // - SAB available: the main side rAF-polls and drains the event ring the
  //   worklet mirrored into the SAB, reinterprets each slot per field, and hands
  //   it to the handler. head / tail / overflowCount are observed via Atomics
  //   inside the SAB.
  // - SAB unavailable: no shared buffer; at the end of each quantum the worklet
  //   ships new emits via `port.postMessage({ kind: 'event', ringIndex,
  //   newSlotsBytes, newSlotCount, overflowCount })`, and the main side
  //   dispatches to subscribers immediately in port.onmessage (= no rAF).
  //   overflowCount is carried into eventOverflowMirror and read by
  //   diagnostics.overflowCount().
  const eventSurface: Record<string, EventSurface<unknown>> = {};
  const eventSubscribers: Map<string, Set<(payload: Record<string, unknown>) => void>> = new Map();
  const eventLocalTails: number[] = eventRings.map(() => 0);
  // For the postMessage path = per-ring overflowCount mirror (= read by diagnostics).
  const eventOverflowMirror: number[] = eventRings.map(() => 0);
  let eventRingsView: DataView | null = null;
  let eventRingsHeaderView: Int32Array | null = null;
  if (eventRingsBuffer !== null && eventRings.length > 0) {
    eventRingsView = new DataView(eventRingsBuffer);
    eventRingsHeaderView = new Int32Array(eventRingsBuffer);
  }
  // Byte view of the §4.3 content buffer (= SAB only). During drain, read the
  // slot's [len, offset] and slice a fresh typed array from here.
  const eventContentBytes: Uint8Array | null =
    eventContentBuffer !== null ? new Uint8Array(eventContentBuffer) : null;
  if (eventRings.length > 0) {
    for (let i = 0; i < eventRings.length; i++) {
      const ring = eventRings[i]!;
      const subscribers = new Set<(payload: Record<string, unknown>) => void>();
      eventSubscribers.set(ring.name, subscribers);
      const sabOffset = eventRingSabOffsets[i]!;
      const overflowSabWordIdx = (sabOffset + 8) >>> 2;
      const ringIndex = i;
      eventSurface[ring.name] = {
        on(handler) {
          subscribers.add(handler as (payload: Record<string, unknown>) => void);
          // SAB path = rAF polling drains + dispatches.
          // postMessage path = port.onmessage-driven (= no polling).
          if (transportMode === "sab") {
            ensureRafLoopRunning();
          }
          return () => {
            subscribers.delete(handler as (payload: Record<string, unknown>) => void);
            if (!hasAnySubscribers()) stopRafLoop();
          };
        },
        diagnostics: {
          overflowCount(): number {
            if (transportMode === "sab" && eventRingsHeaderView !== null) {
              return Atomics.load(eventRingsHeaderView, overflowSabWordIdx);
            }
            // postMessage path = read from the mirror (= the worklet has already
            // shipped the latest value, carried into eventOverflowMirror).
            return eventOverflowMirror[ringIndex]!;
          },
        },
      } as EventSurface<unknown>;
    }
  }

  // Build the message ring sender surface; the path forks on transport mode:
  //
  // - SAB available: the main side pushes a slot into the SAB + head += 1. The
  //   overflow path = drop-oldest when head - tail >= capacity (= tail += 1 +
  //   overflowCount += 1). diagnostics.overflowCount() = Atomics.load from the SAB.
  // - SAB unavailable: no shared buffer = send directly via
  //   `node.port.postMessage({ kind: 'message', ringIndex, payload })`; the
  //   worklet receives it in self.port.onmessage + injects into the WASM ring,
  //   and when WASM-internal drop-oldest fires it notifies main via
  //   port.postMessage (= updates messageOverflowMirror).
  //   diagnostics.overflowCount() = read from the mirror.
  const messageOverflowMirror: number[] = messageRings.map(() => 0);
  let messageRingsView: DataView | null = null;
  let messageRingsHeaderView: Int32Array | null = null;
  if (messageRingsBuffer !== null && messageRings.length > 0) {
    messageRingsView = new DataView(messageRingsBuffer);
    messageRingsHeaderView = new Int32Array(messageRingsBuffer);
  }
  // Byte view of the §5.2 content buffer (= SAB only). When sending a
  // typed-array field, push the array bytes here and write [payloadLen,
  // payloadOffset] into the slot.
  const messageContentView: Uint8Array | null =
    messageContentBuffer !== null ? new Uint8Array(messageContentBuffer) : null;
  if (messageRings.length > 0) {
    for (let i = 0; i < messageRings.length; i++) {
      const ring = messageRings[i]!;
      const sabOffset = messageRingSabOffsets[i]!;
      const headWordIdx = sabOffset >>> 2;
      const tailWordIdx = headWordIdx + 1;
      const overflowWordIdx = headWordIdx + 2;
      const slotsBase = sabOffset + 12;
      const isSab = transportMode === "sab";
      const ringIndex = i;
      const sender = (payload: Record<string, unknown>): void => {
        if (isSab && messageRingsView !== null && messageRingsHeaderView !== null) {
          // SAB path = direct SAB write + head/tail management
          const headerView = messageRingsHeaderView;
          const head = Atomics.load(headerView, headWordIdx);
          const tail = Atomics.load(headerView, tailWordIdx);
          if (head - tail >= ring.capacity) {
            Atomics.store(headerView, tailWordIdx, tail + 1);
            Atomics.store(
              headerView,
              overflowWordIdx,
              Atomics.load(headerView, overflowWordIdx) + 1,
            );
          }
          if (ring.slotSize > 0) {
            const slotByteOffset = slotsBase + (head % ring.capacity) * ring.slotSize;
            for (const field of ring.fields) {
              const value = payload[field.name];
              const byteOffset = slotByteOffset + field.offsetInSlot;
              if (field.payloadElementType !== undefined) {
                // typed-array field = write bytes into the content SAB and store
                // [payloadLen(bytes), payloadOffset(relative to region)] in the
                // slot. The worklet mirrors the content region 1:1, so the offset
                // matches relative to the region base.
                if (messageContentView !== null && ArrayBuffer.isView(value)) {
                  const capacity = ring.payloadContent?.capacity ?? 0;
                  // A payload larger than the content region is truncated on
                  // copy (= Q85: no-trap; without clamping, Uint8Array.set throws
                  // RangeError).
                  const copyBytes = Math.min(value.byteLength, capacity);
                  const src = new Uint8Array(value.buffer, value.byteOffset, copyBytes);
                  const contentBase = messageContentSabOffsets[i]!;
                  let cursor = messageContentCursors[i]!;
                  if (cursor + copyBytes > capacity) cursor = 0;
                  messageContentView.set(src, contentBase + cursor);
                  messageRingsView.setUint32(byteOffset, copyBytes, true);
                  messageRingsView.setUint32(byteOffset + 4, cursor, true);
                  messageContentCursors[i] = cursor + copyBytes;
                }
              } else if (typeof value === "boolean") {
                messageRingsView.setInt32(byteOffset, value ? 1 : 0, true);
              } else if (typeof value === "number") {
                messageRingsView.setInt32(byteOffset, value | 0, true);
              }
            }
          }
          Atomics.store(headerView, headWordIdx, head + 1);
        } else {
          // postMessage path = send directly via port.postMessage. The worklet
          // injects field by field into the WASM ring, so carry the payload as-is.
          node.port.postMessage({ kind: "message", ringIndex, payload });
        }
      };
      const emit = sender as EventSurface<unknown>["emit"];
      const diagnostics = {
        overflowCount(): number {
          if (isSab && messageRingsHeaderView !== null) {
            return Atomics.load(messageRingsHeaderView, overflowWordIdx);
          }
          // postMessage path = read from the mirror (= updated by the worklet's
          // message-overflow notification)
          return messageOverflowMirror[ringIndex]!;
        },
      };
      // Merge the message ring's sender into the event surface (Q88). For a
      // same-name in/out pair (Q87), add send (.emit) onto the existing receive
      // (.on) entry, keeping the outbound event side's diagnostics.
      const existingEntry = eventSurface[ring.name] as EventSurface<unknown> | undefined;
      if (existingEntry !== undefined) {
        existingEntry.emit = emit;
      } else {
        eventSurface[ring.name] = { emit, diagnostics } as EventSurface<unknown>;
      }
    }
  }

  // Build the MIDI surface (`11-midi.md` §3). An `in` port uses the same
  // transport as message and exposes `send` / `connectFromWebMIDI`; an `out`
  // port uses the same as event and exposes `onEvent`. Both have
  // `diagnostics.overflowCount`. The fixed 8-byte wire slot is encoded/decoded
  // by the midiWire codec.
  const midiSurface: Record<string, MidiPortSurface> = {};
  // Per-port subscriber for an out port (= event-like): a handler set per type.
  // An in port has none.
  const midiOutSubscribers: Map<
    string,
    Map<MidiEventType, Set<(e: MidiEvent) => void>>
  > = new Map();
  const midiOutLocalTails: number[] = midiRings.map(() => 0);
  // Overflow mirror for the postMessage path (= shared by in/out; a ring index
  // is exclusively in or out, so there is no ambiguity).
  const midiOverflowMirror: number[] = midiRings.map(() => 0);
  let midiRingsView: DataView | null = null;
  let midiRingsHeaderView: Int32Array | null = null;
  if (midiRingsBuffer !== null && midiRings.length > 0) {
    midiRingsView = new DataView(midiRingsBuffer);
    midiRingsHeaderView = new Int32Array(midiRingsBuffer);
  }
  const sysexContentBytes: Uint8Array | null =
    sysexContentBuffer !== null ? new Uint8Array(sysexContentBuffer) : null;

  // atTime → block-local atSample (§4.2). Omitting atTime = 0 (= the next block
  // boundary). A given atTime clamps the sample offset from now into one block
  // (= sub-block accuracy for the near future; the far future saturates to the
  // start of the block, matching the postMessage default).
  const ctxTimeOf = (): number => {
    const t = (context as unknown as { currentTime?: number }).currentTime;
    return typeof t === "number" ? t : 0;
  };
  const sampleRateOf = (): number => {
    const r = (context as unknown as { sampleRate?: number }).sampleRate;
    return typeof r === "number" && r > 0 ? r : 48000;
  };
  const atSampleFromTime = (atTime: number | undefined): number => {
    if (atTime === undefined) return 0;
    const offset = Math.round((atTime - ctxTimeOf()) * sampleRateOf());
    if (offset <= 0) return 0;
    return offset >= SAMPLES_PER_BLOCK ? SAMPLES_PER_BLOCK - 1 : offset;
  };

  // Decode a single 8-byte wire slot (= status/data1/data2 + atSample). For
  // sysex, status 0xF0 reads length-prefixed bytes from content. Shared by both
  // the SAB-poll and postMessage paths (= contentBytes is either the SAB region
  // or the snapshot bundled with the postMessage).
  const decodeMidiSlot = (
    view: DataView,
    slotByteOffset: number,
    ringIndex: number,
    contentBytes: Uint8Array | null,
  ): { event: MidiEvent; atSample: number } => {
    const status = view.getUint8(slotByteOffset);
    const data1 = view.getUint8(slotByteOffset + 1);
    const data2 = view.getUint8(slotByteOffset + 2);
    const atSample = view.getUint32(slotByteOffset + 4, true);
    const sysex = midiRings[ringIndex]!.sysex;
    if (status === 0xf0 && sysex !== undefined && contentBytes !== null) {
      const base = (data1 % sysex.chunks) * sysex.perChunk;
      const len = new DataView(contentBytes.buffer, contentBytes.byteOffset).getUint32(base, true);
      const data = contentBytes.slice(base + 4, base + 4 + len);
      return { event: { type: "sysex", data }, atSample };
    }
    return { event: wireToMidiEvent(status, data1, data2), atSample };
  };

  // Dispatch a decoded event to out-port subscribers (= only fire handlers whose
  // type matches). The main-side `MidiEvent` has no atSample (§2.1: the
  // sample-offset is for the worklet's internal sample-accurate gating, and by
  // the time the block completes it is already in the past for main), so pass a
  // plain event.
  const dispatchMidiEvent = (ringName: string, event: MidiEvent): void => {
    const byType = midiOutSubscribers.get(ringName);
    if (byType === undefined) return;
    const handlers = byType.get(event.type);
    if (handlers === undefined || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("unworklet: midi onEvent handler threw", err);
      }
    }
  };

  if (midiRings.length > 0) {
    for (let i = 0; i < midiRings.length; i++) {
      const ring = midiRings[i]!;
      const ringIndex = i;
      const sabOffset = midiRingSabOffsets[i]!;
      const headWordIdx = sabOffset >>> 2;
      const tailWordIdx = headWordIdx + 1;
      const overflowWordIdx = headWordIdx + 2;
      const slotsBase = sabOffset + 12;
      const isSab = transportMode === "sab";

      // inbound (= main → worklet). SAB = write a slot into the ring + head++
      // (drop-oldest); postMessage = send `{ kind:'midi', ringIndex, item }` directly.
      const send = (event: MidiEvent, atTime?: number): void => {
        if (ring.direction !== "in") return;
        const atSample = atSampleFromTime(atTime);
        if (isSab && midiRingsView !== null && midiRingsHeaderView !== null) {
          const headerView = midiRingsHeaderView;
          const head = Atomics.load(headerView, headWordIdx);
          const tail = Atomics.load(headerView, tailWordIdx);
          if (head - tail >= ring.capacity) {
            Atomics.store(headerView, tailWordIdx, tail + 1);
            Atomics.store(
              headerView,
              overflowWordIdx,
              Atomics.load(headerView, overflowWordIdx) + 1,
            );
          }
          const slotByteOffset = slotsBase + (head % ring.capacity) * 8;
          if (event.type === "sysex" && ring.sysex !== undefined && sysexContentBytes !== null) {
            const sysex = ring.sysex;
            const chunkIdx = head % sysex.chunks;
            const contentBase = sysexContentSabOffsets[i]! + chunkIdx * sysex.perChunk;
            const len = Math.min(event.data.length, sysex.perChunk - 4);
            new DataView(sysexContentBytes.buffer).setUint32(contentBase, len, true);
            sysexContentBytes.set(event.data.subarray(0, len), contentBase + 4);
            midiRingsView.setUint8(slotByteOffset, 0xf0);
            midiRingsView.setUint8(slotByteOffset + 1, chunkIdx);
            midiRingsView.setUint32(slotByteOffset + 4, atSample, true);
          } else if (event.type !== "sysex") {
            const { status, data1, data2 } = midiEventToWire(event);
            midiRingsView.setUint8(slotByteOffset, status);
            midiRingsView.setUint8(slotByteOffset + 1, data1);
            midiRingsView.setUint8(slotByteOffset + 2, data2);
            midiRingsView.setUint8(slotByteOffset + 3, 0);
            midiRingsView.setUint32(slotByteOffset + 4, atSample, true);
          }
          Atomics.store(headerView, headWordIdx, head + 1);
        } else {
          const item =
            event.type === "sysex"
              ? { status: 0xf0, data1: 0, data2: 0, atSample, sysex: event.data }
              : { ...midiEventToWire(event), atSample };
          node.port.postMessage({ kind: "midi", ringIndex, item });
        }
      };

      const connectFromWebMIDI = (input: unknown): void => {
        const midiInput = input as { onmidimessage?: ((e: { data: Uint8Array }) => void) | null };
        // Reconstruct a MidiEvent from Web MIDI's MIDIMessageEvent.data (= raw
        // bytes) and send it. For sysex (0xF0), the raw bytes including the
        // trailing 0xF7 go straight into data.
        midiInput.onmidimessage = (e: { data: Uint8Array }): void => {
          const bytes = e.data;
          if (bytes.length === 0) return;
          if (bytes[0]! === 0xf0) {
            send({ type: "sysex", data: bytes });
            return;
          }
          send(wireToMidiEvent(bytes[0]!, bytes[1] ?? 0, bytes[2] ?? 0));
        };
      };

      // outbound (= worklet → main). Register a handler per type; SAB drains via
      // rAF poll, postMessage dispatches in onMidiOutMessage. Returns an
      // unsubscribe function.
      const onEvent = <K extends MidiEventType>(
        type: K,
        handler: (event: Extract<MidiEvent, { type: K }>) => void,
      ): (() => void) => {
        let byType = midiOutSubscribers.get(ring.name);
        if (byType === undefined) {
          byType = new Map();
          midiOutSubscribers.set(ring.name, byType);
        }
        let handlers = byType.get(type);
        if (handlers === undefined) {
          handlers = new Set();
          byType.set(type, handlers);
        }
        handlers.add(handler as (e: MidiEvent) => void);
        if (transportMode === "sab") ensureRafLoopRunning();
        return () => {
          handlers.delete(handler as (e: MidiEvent) => void);
          if (!hasAnySubscribers()) stopRafLoop();
        };
      };

      midiSurface[ring.name] = {
        send,
        connectFromWebMIDI,
        onEvent,
        diagnostics: {
          overflowCount(): number {
            if (isSab && midiRingsHeaderView !== null) {
              return Atomics.load(midiRingsHeaderView, overflowWordIdx);
            }
            return midiOverflowMirror[ringIndex]!;
          },
        },
      };
    }
  }

  // SAB out-ring drain = on each rAF poll, consume the WASM-mirrored SAB ring
  // tail→head + decode + dispatch (= same lifecycle as the event ring poll).
  // Skip in ports.
  function pollMidiOutRings(): void {
    if (midiRingsView === null || midiRingsHeaderView === null) return;
    for (let i = 0; i < midiRings.length; i++) {
      const ring = midiRings[i]!;
      if (ring.direction !== "out") continue;
      const sabOffset = midiRingSabOffsets[i]!;
      const headSabWordIdx = sabOffset >>> 2;
      const currentHead = Atomics.load(midiRingsHeaderView, headSabWordIdx);
      const sabTail = Atomics.load(midiRingsHeaderView, headSabWordIdx + 1);
      const localTail = midiOutLocalTails[i]!;
      let tail = localTail < sabTail ? sabTail : localTail;
      if (tail === currentHead) continue;
      const slotsBase = sabOffset + 12;
      const contentBytes =
        ring.sysex !== undefined && sysexContentBytes !== null
          ? sysexContentBytes.subarray(
              sysexContentSabOffsets[i]!,
              sysexContentSabOffsets[i]! + ring.sysex.perChunk * ring.sysex.chunks,
            )
          : null;
      while (tail !== currentHead) {
        const slotByteOffset = slotsBase + (tail % ring.capacity) * 8;
        const { event } = decodeMidiSlot(midiRingsView, slotByteOffset, i, contentBytes);
        dispatchMidiEvent(ring.name, event);
        tail += 1;
      }
      midiOutLocalTails[i] = tail;
    }
  }

  // rAF polling driver = walk every publish slot + every event ring. For
  // publish, fire subscribers on detecting a version increase; for event, drain
  // however far head has advanced past the main-local tail + fire the per-slot
  // handler. Starts on the first subscribe and stops once all subscribers
  // unsubscribe or on dispose (= matching the rAF lifecycle).
  function pollPublishSlots(): void {
    if (publishSharedView === null) return;
    for (let i = 0; i < publishSlots.length; i++) {
      const slot = publishSlots[i]!;
      const versionSlotIdx = i * 3 + 2;
      const currentVersion =
        transportMode === "sab"
          ? Atomics.load(publishSharedView, versionSlotIdx)
          : publishSharedView[versionSlotIdx]!;
      if (currentVersion === lastSeenVersions[i]) continue;
      lastSeenVersions[i] = currentVersion;
      const subscribers = stateSubscribers.get(slot.name);
      if (!subscribers || subscribers.size === 0) continue;
      const valueSlotIdx = i * 3;
      const bits =
        transportMode === "sab"
          ? Atomics.load(publishSharedView, valueSlotIdx)
          : publishSharedView[valueSlotIdx]!;
      const value = convertStateValue(bits, slot.type);
      for (const handler of subscribers) {
        try {
          handler(value);
        } catch (err) {
          console.error("unworklet: state subscribe handler threw", err);
        }
      }
    }
  }

  function pollEventRings(): void {
    if (eventRingsView === null || eventRingsHeaderView === null) return;
    for (let i = 0; i < eventRings.length; i++) {
      const ring = eventRings[i]!;
      const sabOffset = eventRingSabOffsets[i]!;
      const headSabWordIdx = sabOffset >>> 2;
      const currentHead =
        transportMode === "sab"
          ? Atomics.load(eventRingsHeaderView, headSabWordIdx)
          : eventRingsHeaderView[headSabWordIdx]!;
      // drop-oldest may have fired on the worklet side → the SAB tail may have
      // advanced past the main-local tail, so rewind to max(localTail, sabTail)
      // and drain.
      const tailSabWordIdx = headSabWordIdx + 1;
      const sabTail =
        transportMode === "sab"
          ? Atomics.load(eventRingsHeaderView, tailSabWordIdx)
          : eventRingsHeaderView[tailSabWordIdx]!;
      const localTail = eventLocalTails[i]!;
      let tail = localTail < sabTail ? sabTail : localTail;
      if (tail === currentHead) continue;
      const subscribers = eventSubscribers.get(ring.name);
      const slotsBase = sabOffset + 12;
      while (tail !== currentHead) {
        const slotIdx = tail % ring.capacity;
        const slotByteOffset = slotsBase + slotIdx * ring.slotSize;
        if (subscribers !== undefined && subscribers.size > 0) {
          const payload: Record<string, unknown> = {};
          for (const field of ring.fields) {
            const fieldByteOffset = slotByteOffset + field.offsetInSlot;
            if (field.payloadElementType !== undefined && eventContentBytes !== null) {
              // typed-array field = read the slot's [payloadLen, payloadOffset]
              // and slice a fresh typed array from the SAB content region (= §4.3).
              const payloadLen = eventRingsView.getInt32(fieldByteOffset, true);
              const payloadOffset = eventRingsView.getInt32(fieldByteOffset + 4, true);
              const absBase = eventContentSabOffsets[i]! + payloadOffset;
              payload[field.name] = sliceTypedArray(
                eventContentBytes.subarray(absBase, absBase + payloadLen),
                field.payloadElementType,
              );
            } else {
              payload[field.name] = readEventFieldValue(
                eventRingsView,
                fieldByteOffset,
                field.wireType,
              );
            }
          }
          for (const handler of subscribers) {
            try {
              handler(payload);
            } catch (err) {
              console.error("unworklet: event handler threw", err);
            }
          }
        }
        tail += 1;
      }
      eventLocalTails[i] = tail;
    }
  }

  function ensureRafLoopRunning(): void {
    if (rafHandle !== null || disposed) return;
    /* v8 ignore next 1 — the publish / event / midi-out surfaces are already wired via the subscribe path = unreachable defensive */
    if (publishSharedView === null && eventRingsView === null && midiRingsView === null) return;
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
      .requestAnimationFrame;
    if (!raf) return;
    // No disposed branch inside tick = `dispose()` has stopRafLoop call
    // cancelAnimationFrame and set rafHandle to null = any pending tick is also
    // cancelled and there is no re-schedule path = no defensive disposed check
    // needed.
    const tick = (): void => {
      pollPublishSlots();
      pollEventRings();
      pollMidiOutRings();
      rafHandle = raf(tick);
    };
    rafHandle = raf(tick);
  }

  function stopRafLoop(): void {
    if (rafHandle === null) return;
    const cancel = (globalThis as { cancelAnimationFrame?: (handle: number) => void })
      .cancelAnimationFrame;
    if (cancel) cancel(rafHandle);
    rafHandle = null;
  }

  // Whether every publish slot + every event ring + every midi-out port has
  // zero subscribers. Used to decide when to stop rAF polling once unsubscribe
  // has brought them all to zero.
  function hasAnySubscribers(): boolean {
    for (const subs of stateSubscribers.values()) {
      if (subs.size > 0) return true;
    }
    for (const subs of eventSubscribers.values()) {
      if (subs.size > 0) return true;
    }
    for (const byType of midiOutSubscribers.values()) {
      for (const handlers of byType.values()) {
        if (handlers.size > 0) return true;
      }
    }
    return false;
  }

  // Drop `undefined` entries from initial param data — Web Audio's
  // `parameterData` is a `Record<string, double>`, and Firefox throws
  // `TypeError` when a key carries an undefined value (Chrome treats it
  // as no-op). Normalize here so both engines see the same shape.
  const parameterData = options?.initial
    ? (Object.fromEntries(
        Object.entries(options.initial).filter(([, v]) => typeof v === "number"),
      ) as Record<string, number>)
    : undefined;

  // `outputChannelCount` is only legal when `numberOfOutputs > 0`. With
  // zero outputs the W3C AudioWorkletNode constructor throws
  // `IndexSizeError` if `outputChannelCount.length` does not match
  // `numberOfOutputs` (= conservative engines reject `[]` mismatch even
  // though both lengths are 0). Omit the field for input-only / MIDI-only
  // processors instead of forcing the empty array.
  const nodeOptions: AudioWorkletNodeOptions = {
    numberOfInputs: inputs.length,
    numberOfOutputs: outputs.length,
    parameterData,
    // Hand the audio thread a pre-compiled `WebAssembly.Module` (= structured
    // cloneable per W3C wasm-web-api spec) so the worklet only needs to
    // `new WebAssembly.Instance(module)` (= no sync compile on the audio
    // thread = no first-quantum glitch potential).
    processorOptions: {
      module: wasmModule,
      // When there are publish slots = hand over the descriptor + transport for
      // both transport modes (= the worklet template receives them in initialize
      // and runs the publish-copy logic at the end of each quantum). publishBuffer
      // is handed over only under SAB (= on the postMessage path structured clone
      // makes a separate instance = cannot mirror; the worklet notifies
      // individually via port.postMessage = no buffer needed).
      ...(publishSlots.length > 0
        ? {
            publishSlots,
            transport: transportMode,
            ...(publishBuffer !== null ? { publishBuffer } : {}),
          }
        : {}),
      // When there are event rings = hand over the descriptor + transport for
      // both transport modes. eventRingsBuffer is handed over only under SAB
      // (= on the postMessage path structured clone makes a separate instance =
      // cannot mirror; the worklet ships each new emit individually via
      // port.postMessage).
      ...(eventRings.length > 0
        ? {
            eventRings,
            eventRingSabOffsets,
            transport: transportMode,
            ...(eventRingsBuffer !== null ? { eventRingsBuffer } : {}),
            eventContentSabOffsets,
            ...(eventContentBuffer !== null ? { eventContentBuffer } : {}),
          }
        : {}),
      // When there are message rings = hand over the descriptor + transport for
      // both transport modes. messageRingsBuffer is handed over only under SAB
      // (= on the postMessage path the main side sends directly via
      // port.postMessage and the worklet receives it in self.port.onmessage =
      // no buffer needed at all).
      ...(messageRings.length > 0
        ? {
            messageRings,
            messageRingSabOffsets,
            transport: transportMode,
            ...(messageRingsBuffer !== null ? { messageRingsBuffer } : {}),
            messageContentSabOffsets,
            ...(messageContentBuffer !== null ? { messageContentBuffer } : {}),
          }
        : {}),
      // When there are MIDI rings = hand over the descriptor + offset + transport.
      // The buffer is handed over only under SAB (= on the postMessage path main
      // sends `{ kind:'midi' }` directly and the worklet ships `{ kind:'midiOut' }`
      // = no main-side buffer needed).
      ...(midiRings.length > 0
        ? {
            midiRings,
            midiRingSabOffsets,
            sysexContentSabOffsets,
            transport: transportMode,
            ...(midiRingsBuffer !== null ? { midiRingsBuffer } : {}),
            ...(sysexContentBuffer !== null ? { sysexContentBuffer } : {}),
          }
        : {}),
    },
  };
  if (outputs.length > 0) {
    nodeOptions.outputChannelCount = outputs.map((o) => o.channels);
  }

  const node = new (
    globalThis as unknown as { AudioWorkletNode: typeof AudioWorkletNode }
  ).AudioWorkletNode(context as unknown as BaseAudioContext, processorName, nodeOptions);

  try {
    await awaitReady(node);
  } catch (err) {
    // The constructor succeeded but the handshake failed (= init-error
    // posted by the worklet, `processorerror` fired, or the 10s timeout
    // tripped). Caller never sees an `UnworkletNode`, so they cannot call
    // `dispose()` themselves — tear down the half-built node here. MDN
    // documents that a `processorerror`-d node outputs silence for the
    // rest of its lifetime, so without this cleanup repeated retries
    // accumulate silent processor instances + open ports inside the
    // AudioContext. Best-effort: swallow secondary errors so the original
    // failure is what surfaces to the caller.
    try {
      node.disconnect();
    } catch {
      // Already disconnected; ignore.
    }
    try {
      node.port.close();
    } catch {
      // Port may already be closed; ignore.
    }
    throw err;
  }

  const paramDescriptors = ns.parameterDescriptors as readonly { name: string }[];
  const params = buildParams(node, paramDescriptors);

  // Long-lived error forwarder = installed AFTER awaitReady's init-time
  // listeners are removed so the runtime error path (= worklet `{ kind:
  // "error", ... }` messages + `processorerror` event) keeps flowing to
  // `onError(handler)` subscribers for the node's lifetime. docs/05-client.md
  // §2 declares `onError` as the discriminated-union surface for 4 codes
  // (`wasm-trap` / `queue-overflow` / `sab-unavailable` / `block-length-mismatch`).
  // Phase 6 wires the forwarder skeleton — only `block-length-mismatch` (= from
  // `worklet.ts` runtime guard) and `wasm-trap` (= from `processorerror`) are
  // posted at this stage. `queue-overflow` / `sab-unavailable` plumbing lands when
  // the matching transports ship (= 02-messaging.md / 04-worklet-runtime.md §8).
  const errorSubscribers = new Set<(event: NodeErrorEvent) => void>();
  const dispatchError = (event: NodeErrorEvent): void => {
    for (const fn of errorSubscribers) {
      try {
        fn(event);
      } catch (subscriberErr) {
        console.error("unworklet: onError subscriber threw", subscriberErr);
      }
    }
  };
  /**
   * Set of `NodeErrorEvent.code` values the runtime posts. Used
   * to drop unknown / malformed `{ kind: "error", ... }` messages instead
   * of forwarding their raw shape to subscribers as if they were typed
   * `NodeErrorEvent`s (= prevents the structured-union contract from
   * silently widening when an unrelated message slips through).
   */
  const KNOWN_ERROR_CODES = new Set<NodeErrorEvent["code"]>([
    "wasm-trap",
    "queue-overflow",
    "sab-unavailable",
    "block-length-mismatch",
    "worklet-initialize-not-called",
  ]);
  const onErrorMessage = (event: MessageEvent): void => {
    const data = event.data as { kind?: unknown; code?: unknown } | null | undefined;
    if (typeof data !== "object" || data === null) return;
    if (data.kind !== "error") return;
    if (typeof data.code !== "string") return;
    if (!KNOWN_ERROR_CODES.has(data.code as NodeErrorEvent["code"])) return;
    // Strip the internal `kind` framing field so subscribers receive an
    // exact `NodeErrorEvent` (= docs/05-client.md §2 + 04-worklet-runtime
    // §8 declared shape, no extra `kind`).
    const { kind: _kind, ...rest } = data as Record<string, unknown> & { kind: "error" };
    dispatchError(rest as unknown as NodeErrorEvent);
  };
  const onErrorProcessor = (_event: Event): void => {
    // MDN documents the `processorerror` event as a plain `Event` with no
    // payload — there is no portable `.message` to read. The structured
    // wasm-trap details (= the actual error message) come through the
    // `{ kind: "error", code: "wasm-trap", message }` path on the port.
    // This handler only fires when the audio thread couldn't post that
    // message (= constructor / process trap before the structured catch
    // ran), so emit a fixed fallback marker.
    dispatchError({
      code: "wasm-trap",
      message: "AudioWorkletProcessor reported a failure (processorerror)",
    });
  };
  node.port.addEventListener("message", onErrorMessage);
  node.addEventListener("processorerror", onErrorProcessor);

  // Publish listener for the postMessage path (= when SAB is unavailable, on a
  // version advance the worklet posts `port.postMessage({ kind: 'publish',
  // slotIndex, valueBits, sampleCounter, version })` = the main side immediately
  // updates the mirror + dispatches to subscribers. Under SAB the worklet
  // Atomics.stores directly into the SAB = this listener does nothing and drops).
  const onPublishMessage = (event: MessageEvent): void => {
    const data = event.data as
      | { kind?: unknown; slotIndex?: unknown; valueBits?: unknown; version?: unknown }
      | null
      | undefined;
    if (typeof data !== "object" || data === null) return;
    if (data.kind !== "publish") return;
    if (typeof data.slotIndex !== "number") return;
    if (typeof data.valueBits !== "number") return;
    if (typeof data.version !== "number") return;
    const slotIndex = data.slotIndex;
    if (slotIndex < 0 || slotIndex >= publishSlots.length) return;
    const slot = publishSlots[slotIndex]!;
    postMessageMirrorBits[slotIndex] = data.valueBits;
    postMessageMirrorVersions[slotIndex] = data.version;
    const subscribers = stateSubscribers.get(slot.name);
    if (!subscribers || subscribers.size === 0) return;
    const value = convertStateValue(data.valueBits, slot.type);
    for (const handler of subscribers) {
      try {
        handler(value);
      } catch (err) {
        console.error("unworklet: state subscribe handler threw", err);
      }
    }
  };
  if (transportMode === "postMessage" && publishSlots.length > 0) {
    node.port.addEventListener("message", onPublishMessage);
  }

  // Event listener for the postMessage path (= when SAB is unavailable, the
  // worklet ships new emits via `port.postMessage({ kind: 'event', ringIndex,
  // newSlotsBytes, newSlotCount, overflowCount })` = the main side turns them
  // into payload objects + dispatches to subscribers + updates the overflowCount
  // mirror). Drops under SAB.
  const onEventMessage = (event: MessageEvent): void => {
    const data = event.data as
      | {
          kind?: unknown;
          ringIndex?: unknown;
          newSlotsBytes?: unknown;
          newSlotCount?: unknown;
          overflowCount?: unknown;
          contentBytes?: unknown;
        }
      | null
      | undefined;
    if (typeof data !== "object" || data === null) return;
    if (data.kind !== "event") return;
    if (typeof data.ringIndex !== "number") return;
    const ringIndex = data.ringIndex;
    if (ringIndex < 0 || ringIndex >= eventRings.length) return;
    const ring = eventRings[ringIndex]!;
    // Update the overflowCount mirror (= the read source for diagnostics.overflowCount())
    if (typeof data.overflowCount === "number") {
      eventOverflowMirror[ringIndex] = data.overflowCount;
    }
    // Turn slots into payload objects + dispatch to subscribers
    if (
      data.newSlotsBytes instanceof ArrayBuffer &&
      typeof data.newSlotCount === "number" &&
      data.newSlotCount > 0
    ) {
      const subscribers = eventSubscribers.get(ring.name);
      if (!subscribers || subscribers.size === 0) return;
      const view = new DataView(data.newSlotsBytes);
      // For §4.3 typed-array fields = the content snapshot the worklet bundled in
      // (= a single payload at offset 0). Slice from here by the slot's
      // [payloadLen, payloadOffset].
      const contentBytes =
        data.contentBytes instanceof ArrayBuffer ? new Uint8Array(data.contentBytes) : null;
      for (let k = 0; k < data.newSlotCount; k++) {
        const slotByteOffset = k * ring.slotSize;
        const payload: Record<string, unknown> = {};
        for (const field of ring.fields) {
          const fieldByteOffset = slotByteOffset + field.offsetInSlot;
          if (field.payloadElementType !== undefined && contentBytes !== null) {
            const payloadLen = view.getInt32(fieldByteOffset, true);
            const payloadOffset = view.getInt32(fieldByteOffset + 4, true);
            payload[field.name] = sliceTypedArray(
              contentBytes.subarray(payloadOffset, payloadOffset + payloadLen),
              field.payloadElementType,
            );
            continue;
          }
          payload[field.name] = readEventFieldValue(view, fieldByteOffset, field.wireType);
        }
        for (const handler of subscribers) {
          try {
            handler(payload);
          } catch (err) {
            console.error("unworklet: event handler threw", err);
          }
        }
      }
    }
  };
  if (transportMode === "postMessage" && eventRings.length > 0) {
    node.port.addEventListener("message", onEventMessage);
  }

  // Message overflow listener for the postMessage path (= when SAB is
  // unavailable and drop-oldest fires on the worklet-side WASM ring, raising
  // overflowCount, it is notified via
  // `port.postMessage({ kind: 'message-overflow', ringIndex, overflowCount })` =
  // the main side updates messageOverflowMirror so diagnostics.overflowCount()
  // can read it). Under SAB the main side observes the SAB header directly = drops.
  const onMessageOverflowMessage = (event: MessageEvent): void => {
    const data = event.data as
      | { kind?: unknown; ringIndex?: unknown; overflowCount?: unknown }
      | null
      | undefined;
    if (typeof data !== "object" || data === null) return;
    if (data.kind !== "message-overflow") return;
    if (typeof data.ringIndex !== "number") return;
    if (typeof data.overflowCount !== "number") return;
    const ringIndex = data.ringIndex;
    if (ringIndex < 0 || ringIndex >= messageRings.length) return;
    messageOverflowMirror[ringIndex] = data.overflowCount;
  };
  if (transportMode === "postMessage" && messageRings.length > 0) {
    node.port.addEventListener("message", onMessageOverflowMessage);
  }

  // MIDI outbound listener for the postMessage path (= the worklet-side out-ring
  // drain ships `{ kind:'midiOut', ringIndex, newSlotsBytes, newSlotCount,
  // overflowCount, sysexBytes? }` = the main side decodes each slot + dispatches
  // to type-matching handlers + updates the overflow mirror).
  const onMidiOutMessage = (event: MessageEvent): void => {
    const data = event.data as
      | {
          kind?: unknown;
          ringIndex?: unknown;
          newSlotsBytes?: unknown;
          newSlotCount?: unknown;
          overflowCount?: unknown;
          sysexBytes?: unknown;
        }
      | null
      | undefined;
    if (typeof data !== "object" || data === null) return;
    if (data.kind !== "midiOut") return;
    if (typeof data.ringIndex !== "number") return;
    const ringIndex = data.ringIndex;
    if (ringIndex < 0 || ringIndex >= midiRings.length) return;
    const ring = midiRings[ringIndex]!;
    if (typeof data.overflowCount === "number") {
      midiOverflowMirror[ringIndex] = data.overflowCount;
    }
    if (
      data.newSlotsBytes instanceof ArrayBuffer &&
      typeof data.newSlotCount === "number" &&
      data.newSlotCount > 0
    ) {
      const view = new DataView(data.newSlotsBytes);
      const contentBytes =
        data.sysexBytes instanceof ArrayBuffer ? new Uint8Array(data.sysexBytes) : null;
      for (let k = 0; k < data.newSlotCount; k++) {
        const { event: decoded } = decodeMidiSlot(view, k * 8, ringIndex, contentBytes);
        dispatchMidiEvent(ring.name, decoded);
      }
    }
  };
  if (transportMode === "postMessage" && midiRings.length > 0) {
    node.port.addEventListener("message", onMidiOutMessage);
  }

  // MIDI inbound overflow listener for the postMessage path (= when drop-oldest
  // fires on the worklet-side in-ring, it is notified via
  // `{ kind:'midi-overflow', ringIndex, overflowCount }` = the main side updates
  // the mirror so diagnostics.overflowCount() can read it).
  const onMidiOverflowMessage = (event: MessageEvent): void => {
    const data = event.data as
      | { kind?: unknown; ringIndex?: unknown; overflowCount?: unknown }
      | null
      | undefined;
    if (typeof data !== "object" || data === null) return;
    if (data.kind !== "midi-overflow") return;
    if (typeof data.ringIndex !== "number") return;
    if (typeof data.overflowCount !== "number") return;
    const ringIndex = data.ringIndex;
    if (ringIndex < 0 || ringIndex >= midiRings.length) return;
    midiOverflowMirror[ringIndex] = data.overflowCount;
  };
  if (transportMode === "postMessage" && midiRings.length > 0) {
    node.port.addEventListener("message", onMidiOverflowMessage);
  }

  // snapshot / restore request-response (`05-client.md` §2.6 + `01-dsl.md` §8).
  // Round-trips over port messages rather than the SAB = the worklet reads /
  // writes linear memory in onmessage (= the render-quantum boundary), so it is
  // block-atomic (= §6.1). Each request gets a sequential id, and the worklet's
  // response is matched against the pending map to resolve.
  let snapshotRequestSeq = 0;
  type RestoreReport = { applied: string[]; skipped: string[]; missing: string[] };
  const pendingSnapshots = new Map<
    number,
    { resolve: (slots: SnapshotSlot[]) => void; reject: (err: Error) => void }
  >();
  const pendingRestores = new Map<
    number,
    { resolve: (report: RestoreReport) => void; reject: (err: Error) => void }
  >();
  // Dev X-ray dumps share the request-id sequence + the snapshot port listener.
  const pendingDevDumps = new Map<
    number,
    { resolve: (slots: SnapshotSlot[]) => void; reject: (err: Error) => void }
  >();
  // Settle (= reject) every in-flight snapshot / restore, then clear. The worklet
  // response is the only resolve signal, so on teardown (dispose) or a dead audio
  // thread (processorerror) an un-settled promise would hang the caller forever.
  const rejectAllPending = (reason: string): void => {
    const err = new Error(`unworklet: ${reason}`);
    for (const pending of pendingSnapshots.values()) pending.reject(err);
    pendingSnapshots.clear();
    for (const pending of pendingRestores.values()) pending.reject(err);
    pendingRestores.clear();
    for (const pending of pendingDevDumps.values()) pending.reject(err);
    pendingDevDumps.clear();
  };
  const onProcessorErrorSettle = (): void => {
    rejectAllPending("the audio thread reported a failure (processorerror)");
  };
  node.addEventListener("processorerror", onProcessorErrorSettle);
  const onSnapshotMessage = (event: MessageEvent): void => {
    const data = event.data as
      | {
          kind?: unknown;
          requestId?: unknown;
          slots?: unknown;
          applied?: unknown;
          skipped?: unknown;
          missing?: unknown;
        }
      | null
      | undefined;
    if (typeof data !== "object" || data === null) return;
    if (typeof data.requestId !== "number") return;
    if (data.kind === "snapshot-response") {
      const pending = pendingSnapshots.get(data.requestId);
      if (pending === undefined) return;
      pendingSnapshots.delete(data.requestId);
      pending.resolve(Array.isArray(data.slots) ? (data.slots as SnapshotSlot[]) : []);
    } else if (data.kind === "restore-done") {
      const pending = pendingRestores.get(data.requestId);
      if (pending === undefined) return;
      pendingRestores.delete(data.requestId);
      pending.resolve({
        applied: Array.isArray(data.applied) ? (data.applied as string[]) : [],
        skipped: Array.isArray(data.skipped) ? (data.skipped as string[]) : [],
        missing: Array.isArray(data.missing) ? (data.missing as string[]) : [],
      });
    } else if (data.kind === "dev-dump-response") {
      const pending = pendingDevDumps.get(data.requestId);
      if (pending === undefined) return;
      pendingDevDumps.delete(data.requestId);
      pending.resolve(Array.isArray(data.slots) ? (data.slots as SnapshotSlot[]) : []);
    }
  };
  node.port.addEventListener("message", onSnapshotMessage);

  const snapshot = (options?: { profile?: string }): Promise<Uint8Array> => {
    if (disposed) {
      // No worklet to answer a disposed node — reject rather than pend forever.
      return Promise.reject(new Error("unworklet: snapshot() called on a disposed node"));
    }
    const requestId = snapshotRequestSeq++;
    const profile = options?.profile;
    return new Promise<Uint8Array>((resolve, reject) => {
      pendingSnapshots.set(requestId, {
        resolve: (slots) => resolve(encodeSnapshot(processor.schemaHash, profile ?? null, slots)),
        reject,
      });
      node.port.postMessage({ kind: "snapshot-request", requestId, profile });
    });
  };

  const restore = async (blob: Uint8Array): Promise<RestoreResult> => {
    if (disposed) {
      // A disposed node has no worklet to apply into — fail loud, never pend.
      return {
        ok: false,
        error: {
          step: "restore",
          message: "restore() called on a disposed node",
          cause: undefined,
        },
        applied: [],
        restored: 0,
        skipped: [],
        missing: [],
      };
    }
    // Migrate the blob to the current schema first (`01-dsl.md` §8.3). A throwing
    // migrate step fails the whole restore = the live node keeps its current state.
    const migrated = runMigrations(blob, processor.migrations ?? [], processor.schemaHash);
    if (!migrated.ok) {
      return {
        ok: false,
        error: migrated.error,
        applied: [],
        restored: 0,
        skipped: [],
        missing: [],
      };
    }
    const decoded = decodeSnapshot(migrated.blob);
    const requestId = snapshotRequestSeq++;
    // Hand ALL slots to the worklet — it is the single authority on declarations,
    // so it computes applied / skipped / missing (across state / buffer / param) +
    // writes state / buffer into linear memory at the quantum boundary. dispose() /
    // processorerror reject the pending promise so a torn-down node never hangs here.
    let report: RestoreReport;
    try {
      report = await new Promise<RestoreReport>((resolve, reject) => {
        pendingRestores.set(requestId, { resolve, reject });
        node.port.postMessage({
          kind: "restore",
          requestId,
          slots: decoded.slots,
          // Scope the worklet's `missing` report to the profile the blob was
          // captured under (= not the union of all profiles).
          profile: decoded.profile ?? undefined,
        });
      });
    } catch (err) {
      pendingRestores.delete(requestId);
      return {
        ok: false,
        error: {
          step: "restore",
          message: err instanceof Error ? err.message : "restore did not complete",
          cause: err,
        },
        applied: [],
        restored: 0,
        skipped: [],
        missing: [],
      };
    }
    // param values live on `AudioParam` (main thread), so apply them here using
    // the worklet's authoritative applied report.
    for (const slot of decoded.slots) {
      if (slot.kind !== "param") continue;
      if (!report.applied.includes(slot.name)) continue;
      const ap = params[slot.name];
      if (ap) ap.value = Number(decodeScalar("f32", slot.data));
    }
    return {
      ok: true,
      applied: report.applied,
      restored: report.applied.length,
      skipped: report.skipped,
      missing: report.missing,
    };
  };

  const { handles: inputHandles, proxies: inputProxies } = buildInputProxies(context, node, inputs);

  // Pending flag to fire the sab-unavailable event exactly once (= 04-worklet-
  // runtime.md §8). Unneeded when SAB is available; in a fallback environment it
  // notifies the first onError subscriber exactly once (= assuming a subscriber
  // can subscribe right after createNode; later subscribes drop).
  // (= the `disposed` latch is already declared above on the state-surface build
  // path = not re-declared here)
  let pendingSabUnavailable = !sabAvailable;
  // Dev registry handle: built + registered below only when devtools is active;
  // referenced here so `dispose()` can unregister it.
  let devHandle: DevNodeHandle | undefined;

  const unworkletNode: UnworkletNode<C> = {
    node,
    inputs: inputHandles,
    outputs: buildOutputs(node, outputs) as UnworkletNode<C>["outputs"],
    params,
    state: stateSurface,
    events: eventSurface,
    midi: midiSurface,
    diagnostics: { transport: transportMode },
    snapshot,
    restore,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Settle any in-flight snapshot / restore before tearing down listeners, so
      // awaiting callers get a rejection instead of hanging on a dead node.
      rejectAllPending("node disposed before the worklet responded");
      if (devHandle !== undefined) unregisterDevNode(devHandle);
      stopRafLoop();
      node.port.removeEventListener("message", onErrorMessage);
      node.port.removeEventListener("message", onPublishMessage);
      node.port.removeEventListener("message", onEventMessage);
      node.port.removeEventListener("message", onMessageOverflowMessage);
      node.port.removeEventListener("message", onMidiOutMessage);
      node.port.removeEventListener("message", onMidiOverflowMessage);
      node.port.removeEventListener("message", onSnapshotMessage);
      node.removeEventListener("processorerror", onErrorProcessor);
      node.removeEventListener("processorerror", onProcessorErrorSettle);
      errorSubscribers.clear();
      for (const subs of stateSubscribers.values()) subs.clear();
      for (const subs of eventSubscribers.values()) subs.clear();
      for (const byType of midiOutSubscribers.values()) {
        for (const handlers of byType.values()) handlers.clear();
      }
      // Cut each input proxy's outgoing edge to `node` so audio stops flowing
      // through the disposed processor. Upstream sources connected by the
      // user to `node.inputs.<name>` are their own to disconnect — unworklet
      // does not own the user's graph (= Q4-a / Q6: typed wrappers compose
      // with Web Audio, framework does not mutate user-constructed edges).
      for (const gain of inputProxies) {
        try {
          gain.disconnect();
        } catch {
          // Already disconnected; ignore.
        }
      }
      try {
        node.disconnect();
      } catch {
        // Already disconnected; ignore.
      }
      try {
        node.port.close();
      } catch {
        // Port may already be closed; ignore.
      }
    },
    onError(handler: (event: NodeErrorEvent) => void): () => void {
      if (disposed) {
        // Subscribing after dispose is a no-op (= docs/05-client.md §4 = all
        // subscribers torn down at dispose). Returning a no-op unsubscribe
        // keeps the caller's cleanup path symmetric.
        return () => {};
      }
      errorSubscribers.add(handler);
      // Fire the pending sab-unavailable event exactly once. In a SAB-available
      // environment pendingSabUnavailable = false, so nothing happens. In a
      // fallback environment, notify only the first subscriber; later subscribes
      // drop because the pending flag has already been cleared.
      if (pendingSabUnavailable) {
        pendingSabUnavailable = false;
        try {
          handler({ code: "sab-unavailable" });
        } catch (subscriberErr) {
          console.error("unworklet: onError subscriber threw", subscriberErr);
        }
      }
      return () => {
        errorSubscribers.delete(handler);
      };
    },
    __processor: undefined as unknown as C,
  };

  // Dev-only: auto-register this node so the injected page-script can X-ray it
  // (zero-config — no app code involved). The dump round-trips through the same
  // block-atomic port + pending map / listener as snapshot.
  if (typeof __UNWORKLET_DEVTOOLS__ !== "undefined" && __UNWORKLET_DEVTOOLS__ === true) {
    const devDump = (): Promise<SnapshotSlot[]> => {
      if (disposed) {
        return Promise.reject(new Error("unworklet: devDump() called on a disposed node"));
      }
      const requestId = snapshotRequestSeq++;
      return new Promise<SnapshotSlot[]>((resolve, reject) => {
        pendingDevDumps.set(requestId, { resolve, reject });
        node.port.postMessage({ kind: "dev-dump-request", requestId });
      });
    };
    devHandle = {
      node: unworkletNode as UnworkletNode<unknown>,
      processorName,
      displayName: displayName ?? processorName,
      schemaHash: processor.schemaHash,
      midiPorts: midiRings.map((r) => ({ name: r.name, direction: r.direction })),
      devDump,
    };
    registerDevNode(devHandle);
  }

  return unworkletNode;
}

export function inspect(blob: Uint8Array): InspectionResult {
  // Pure blob decode (= no AudioContext / live processor needed, Q48).
  return inspectSnapshot(blob);
}
