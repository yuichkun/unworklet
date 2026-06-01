/**
 * Main-thread client surface (`05-client.md` §1 + §2)。
 *
 * - `createNode(context, processor, options?)` — `?worklet` 経 由 で
 *   augment さ れ た CompiledProcessor を 受 け 取 り、 `addModule` +
 *   `fetch(wasmUrl)` + `new AudioWorkletNode(...)` + readiness handshake
 *   を 経 て typed `UnworkletNode<C>` を 返 す。 audioWorklet.addModule
 *   は (context, moduleUrl) ご と に cache し て 二 重 register を 防 ぐ。
 * - `UnworkletNode<C>` full surface = `node` / `inputs.<name>` /
 *   `outputs.<name>` / `params.<name>` / `state` / `events` / `messages` /
 *   `midi` / `snapshot` / `restore` / `onError` / `diagnostics` / `dispose()`。
 * - `inspect(blob)` — non-realtime free function (Q48)、 `AudioContext` 不 要。
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
 * publishShared region 内 の i32 bit pattern を user surface 型 に 変 換
 * (= sub-phase 7.5)。 f32 は bit pattern を Float32Array 経 由 で reinterpret、
 * bool は 0/1 → boolean、 i32 は そ の ま ま。 publish 対 応 type は Q42 で
 * f32 / i32 / bool 限 定 = 当 関 数 で 全 path cover。 module-level Float32Array
 * temp を 持 ち 回 す と main thread side で alloc が 発 生 する path = function-
 * level temp で 1 回 alloc + reuse (= main 側 = audio thread invariant の 対 象
 * 外、 ただ し 大 量 polling で の alloc 削 減 で 持 ち 回 し)。
 */
const F32_REINTERPRET_BUF = new ArrayBuffer(4);
const F32_REINTERPRET_FLOAT = new Float32Array(F32_REINTERPRET_BUF);
const F32_REINTERPRET_INT = new Int32Array(F32_REINTERPRET_BUF);

/**
 * event ring slot か ら per-field 値 を reinterpret し て plain JS 値 で 取 る
 * (= sub-phase 7.6 commit 6)。 wireType は 1 番 目 emit で seal さ れ た 型
 * (= Q71)、 main 側 で は plain JS 値 (= number / boolean / bigint) と し て 公 開
 * (= EmitPayload で の Node<T> path は worklet 側 だ け、 main は 自 然 JS)。
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
 * §4.3 typed-array event field の content bytes を element type 別 の fresh typed
 * array に reinterpret (= worklet→main、 main 側 は natural JS typed array)。 `bytes`
 * を slice で copy し て non-shared / 0-align の ArrayBuffer に し て か ら view を 張 る。
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
  return bits; // i32 / その 他 = そ の ま ま (= Q42 で publish 対 応 は f32 / i32 / bool 限 定)
}

// Per-context `addModule` deduplication。 The cache stores the in-flight (or
// settled) Promise itself, NOT just a "registered" flag — concurrent
// `createNode()` calls for the same `(context, moduleUrl)` would otherwise
// both miss the cache during the addModule round-trip and both call
// `audioWorklet.addModule(...)`, which then hits `registerProcessor()` twice
// with the same name (= MDN: duplicate name throws `NotSupportedError`)。
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
  // network blip should not permanently poison this (context, url))。
  const promise = context.audioWorklet.addModule(url).catch((err: unknown) => {
    perContext!.delete(url);
    throw err;
  });
  perContext.set(url, promise);
  return promise;
};

/**
 * Fetch WASM bytes + asynchronously compile to a `WebAssembly.Module` on
 * the main thread。 The compiled `Module` is structured-clone-safe (= W3C
 * wasm-web-api spec) and is what we hand off via
 * `AudioWorkletNodeOptions.processorOptions.module`, so the audio thread
 * only has to `new WebAssembly.Instance(module)` (= fast、 deterministic
 * cost) instead of a sync `new WebAssembly.Module(bytes)` (= MDN
 * explicitly recommends the async path for production)。 First-quantum
 * glitch potential disappears + Chrome's 4KB sync-compile reject path is
 * sidestepped entirely。
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
  // copy in conformant browsers。 Fall back to `WebAssembly.compile`
  // with the buffer for other content types / older engines。
  const ct = response.headers?.get?.("Content-Type") ?? "";
  if (typeof WebAssembly.compileStreaming === "function" && /application\/wasm\b/.test(ct)) {
    return await WebAssembly.compileStreaming(response);
  }
  const bytes = await response.arrayBuffer();
  return await WebAssembly.compile(bytes);
};

/**
 * Build per-`audioInput` AudioNode destinations。 Each port gets a
 * pass-through `GainNode(gain=1)` pre-wired to the underlying
 * `AudioWorkletNode` at the correct input port index。 Users write
 * `source.connect(node.inputs.main)` and Web Audio routes the signal through
 * the gain proxy onto the right worklet input port — no wrapper / monkey
 * patching is in the path, just standard `AudioNode.connect(...)`。
 *
 * Returned array is index-aligned with `inputs` so `dispose()` can tear
 * down each gain proxy with one pass。
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
        // and AudioParam (= 2-arg) destinations。 AudioNode exposes a
        // `connect` method, AudioParam does not = duck-type discriminate
        // rather than `instanceof AudioNode` (avoids relying on globals
        // for offline / test environments)。
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
 * Default timeout (ms) for the `createNode` ready handshake。 Triggers a
 * reject if the worklet never posts `{ kind: "ready" }` or `{ kind:
 * "init-error" }` — last-resort safety net for cases the structured paths
 * miss (= bug in the worklet template, message dropped, etc.)。
 */
const READY_TIMEOUT_MS = 10_000;

const awaitReady = (node: AudioWorkletNode): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    // `cleanup()` runs exactly once per settle path — it synchronously
    // removes both event listeners and clears the timer, so once it runs
    // the corresponding handler can no longer fire。 No defensive
    // `if (settled) return` guard is needed in the handlers themselves。
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
      // `processorerror` carries no payload per MDN — surface what we can。
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
    // some polyfilled / older engines surface `InvalidStateError` here。
    // Wrap so the Promise rejects cleanly with cleanup instead of leaving
    // listeners + timer pinned。
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

  // transport mode 検 出 (= sub-phase 7.4)。 publishSlots ゼ ロ で も transport は
  // 計 算 す る (= 後 続 で event<T> / message<T> / midi の SAB ringbuffer path で も
  // 同 transport mode を 使 う = 既 declared diagnostics surface と zip)。
  const sabAvailable =
    typeof SharedArrayBuffer === "function" &&
    typeof globalThis !== "undefined" &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const transportMode: "sab" | "postMessage" = sabAvailable ? "sab" : "postMessage";

  // publish slot 1 つ あ た り 12 byte (= 4 byte publishShared + 8 byte publishCounters)。
  // SAB 時 の み allocate (= postMessage path で は structured clone で main /
  // worklet が 別 ArrayBuffer instance を 持 つ = mirror 不 能、 worklet 側 が
  // port.postMessage 経 路 で 通 知 す る path = main 側 buffer 自 体 不 要)。
  const publishBufferByteLength = publishSlots.length * 12;
  let publishBuffer: SharedArrayBuffer | null = null;
  if (publishBufferByteLength > 0 && sabAvailable) {
    publishBuffer = new SharedArrayBuffer(publishBufferByteLength);
  }

  // event ring buffer。 SAB 時 の み allocate (= postMessage path は structured
  // clone で main / worklet が 別 ring instance に な る = mirror 不 能、 worklet
  // 側 が port.postMessage で 新 emit 分 を 個 別 配 送 す る 経 路 = main 側 buffer
  // 自 体 不 要)。 SAB 時 = 1 SAB に 全 event ring を 連 続 配 置 = per-ring 内
  // offset = declaration 順 累 計 (= main / worklet で 同 path で 計 算)。
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

  // §4.3 content buffer (worklet→main) = typed-array field を 持 つ event ご と に
  // payloadContent.capacity bytes を 連 続 配 置 (= ring index と zip)。 worklet が
  // ここ に WASM content を mirror、 main が drain で slot の [len, offset] で slice。
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

  // message ring buffer。 SAB 時 の み allocate (= postMessage path は main 側 が
  // `port.postMessage({ kind: 'message', ringIndex, payload })` で 直 送、 worklet
  // 側 が self.port.onmessage で receive + messageQueueMirrors に push + process
  // 開 始 で WASM ring に inject = main 側 buffer 自 体 不 要)。 SAB 時 = event ring
  // と zip pattern (= 1 SAB に 連 続 配 置、 main 側 sender が SAB に push)。
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

  // §5.2 variable-length content buffer = typed-array field を 持 つ message ご と に
  // `payloadContent.capacity` bytes を 連 続 配 置 (= ring index と zip、 content ナ シ
  // の ring も offset を hold = 使 用 側 は descriptor.payloadContent 有 無 で 判 断)。
  // SAB 時 = main が ここ に array を push → worklet が WASM content region に mirror。
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

  // MIDI ring buffer (`11-midi.md` §4.4)。 in port = message と 同 transport (main →
  // SAB / postMessage → worklet)、 out port = event と 同 (worklet → SAB / postMessage
  // → main)。 8-byte 固 定 slot = 12 + capacity × 8 byte。 SAB 時 の み allocate。
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
  // §4.3 sysex content buffer = sysex port ご と に perChunk × chunks bytes を 連 続 配 置
  // (= ring index と zip、 sysex ナ シ port も offset を hold)。 SAB 時 の み allocate。
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
  // in port = main が SAB ring に push す る 時 の per-port head cursor は SAB header
  // (= drop-oldest 判 定 で head/tail を Atomics 操 作)。 sysex content の per-port
  // 書 き 込 み cursor は send ご と に head%chunks で 決 ま る = 別 cursor 不 要。

  // main 側 state surface 構 築 = transport mode で 経 路 が 分 岐:
  //
  // - SAB available: publishBuffer の Int32Array view を 各 slot ご と に `.value`
  //   getter 経 由 で Atomics.load + 型 別 reinterpret。 `.subscribe(handler)` は
  //   rAF polling driver を 起 動 し て version counter advance を 検 出 + handler fire。
  // - SAB unavailable: 共 有 buffer 不 在、 worklet 側 が version advance 時 に
  //   `port.postMessage({ kind: 'publish', slotIndex, valueBits, ... })` を 投 げ る
  //   = main 側 で port.onmessage で receive 即 時 に internal mirror state を 更 新
  //   + subscriber dispatch (= rAF 不 要、 polling latency ゼ ロ)。 `.value` getter
  //   は mirror か ら bits read。 `.subscribe` は 単 に subscriber set に 追 加。
  const stateSurface: Record<string, StateValueProxy<unknown>> = {};
  const stateSubscribers: Map<string, Set<(value: unknown) => void>> = new Map();
  const lastSeenVersions: number[] = publishSlots.map(() => 0);
  let rafHandle: number | null = null;
  let disposed = false;
  let publishSharedView: Int32Array | null = null;
  // postMessage path 用 internal mirror (= slotIndex 順 で valueBits / version を
  // 保 持、 port.onmessage で 更 新 + `.value` getter / dedupe diagnostic で 参 照)。
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
          // postMessage path = internal mirror か ら read (= worklet 側 が 最 新 値 を
          // port.postMessage で 投 げ た 結 果 が onPublishMessage で mirror に 反 映 済)。
          return convertStateValue(postMessageMirrorBits[slotIndex]!, slot.type);
        },
        subscribe(handler) {
          subscribers.add(handler);
          // SAB path = rAF polling で version counter advance を 検 出 + dispatch。
          // postMessage path = port.onmessage driven で immediate dispatch = polling 不 要。
          if (transportMode === "sab") {
            ensureRafLoopRunning();
          }
          return () => {
            subscribers.delete(handler);
            // 全 surface の subscriber が 0 に な っ た ら rAF polling を 停 止
            // (= node 生 存 中 の temporary subscribe / unsubscribe で dispose ま で
            // 毎 frame polling し 続 け る main-thread 浪 費 を 回 避)。
            if (!hasAnySubscribers()) stopRafLoop();
          };
        },
      };
    }
  }

  // event ring surface 構 築 = transport mode で 経 路 が 分 岐:
  //
  // - SAB available: worklet が SAB に mirror し た event ring を main 側 rAF
  //   polling で drain + 各 slot を per-field reinterpret し て handler に hand。
  //   head / tail / overflowCount は SAB 内 で Atomics 経 由 で 観 測。
  // - SAB unavailable: 共 有 buffer 不 在、 worklet が 新 emit 分 を per-quantum 末
  //   尾 に `port.postMessage({ kind: 'event', ringIndex, newSlotsBytes,
  //   newSlotCount, overflowCount })` で 配 送 = main 側 で port.onmessage で
  //   receive 即 時 に subscriber dispatch (= rAF 不 要)。 overflowCount は
  //   eventOverflowMirror に carry し て diagnostics.overflowCount() で read。
  const eventSurface: Record<string, EventSurface<unknown>> = {};
  const eventSubscribers: Map<string, Set<(payload: Record<string, unknown>) => void>> = new Map();
  const eventLocalTails: number[] = eventRings.map(() => 0);
  // postMessage path 用 = ring ご と の overflowCount mirror (= diagnostics 読 み 用)。
  const eventOverflowMirror: number[] = eventRings.map(() => 0);
  let eventRingsView: DataView | null = null;
  let eventRingsHeaderView: Int32Array | null = null;
  if (eventRingsBuffer !== null && eventRings.length > 0) {
    eventRingsView = new DataView(eventRingsBuffer);
    eventRingsHeaderView = new Int32Array(eventRingsBuffer);
  }
  // §4.3 content buffer の byte view (= SAB 時 の み)。 drain で slot の [len, offset]
  // を 読 ん で ここ か ら fresh typed array を slice。
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
          // SAB path = rAF polling で drain + dispatch。
          // postMessage path = port.onmessage driven (= polling 不 要)。
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
            // postMessage path = mirror か ら read (= worklet 側 が 最 新 値 を 配 送
            // 済 で eventOverflowMirror に carry さ れ て いる)。
            return eventOverflowMirror[ringIndex]!;
          },
        },
      } as EventSurface<unknown>;
    }
  }

  // message ring sender surface 構 築 = transport mode で 経 路 が 分 岐:
  //
  // - SAB available: main 側 が SAB に slot push + head += 1。 overflow path =
  //   head - tail >= capacity で drop-oldest (= tail += 1 + overflowCount += 1)。
  //   diagnostics.overflowCount() = SAB から Atomics.load。
  // - SAB unavailable: 共 有 buffer 不 在 = `node.port.postMessage({ kind:
  //   'message', ringIndex, payload })` で 直 送 = worklet 側 が self.port.onmessage
  //   で receive + WASM ring に inject + overflow は WASM 内 で drop-oldest 発 動
  //   時 に port.postMessage で main に 通 知 (= messageOverflowMirror 更 新)。
  //   diagnostics.overflowCount() = mirror か ら read。
  const messageOverflowMirror: number[] = messageRings.map(() => 0);
  let messageRingsView: DataView | null = null;
  let messageRingsHeaderView: Int32Array | null = null;
  if (messageRingsBuffer !== null && messageRings.length > 0) {
    messageRingsView = new DataView(messageRingsBuffer);
    messageRingsHeaderView = new Int32Array(messageRingsBuffer);
  }
  // §5.2 content buffer の byte view (= SAB 時 の み)。 typed-array field 送 信 で
  // ここ に array bytes を push、 slot に [payloadLen, payloadOffset] を 書 く。
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
          // SAB path = 既 SAB write + head/tail 管 理
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
                // typed-array field = content SAB に bytes を 書 い て slot に
                // [payloadLen(bytes), payloadOffset(region 相 対)]。 worklet が content
                // region を 1:1 mirror す る の で offset は region base 相 対 で 一 致。
                if (messageContentView !== null && ArrayBuffer.isView(value)) {
                  const capacity = ring.payloadContent?.capacity ?? 0;
                  // content region より大きい payload は truncate し て copy (= Q85:
                  // no-trap。 clamp し な い と Uint8Array.set が RangeError を throw)。
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
          // postMessage path = port.postMessage で 直 送。 worklet 側 で field 別
          // に WASM ring に inject す る た め、 payload を そ の ま ま 載 せ る。
          node.port.postMessage({ kind: "message", ringIndex, payload });
        }
      };
      const emit = sender as EventSurface<unknown>["emit"];
      const diagnostics = {
        overflowCount(): number {
          if (isSab && messageRingsHeaderView !== null) {
            return Atomics.load(messageRingsHeaderView, overflowWordIdx);
          }
          // postMessage path = mirror か ら read (= worklet が message-overflow
          // 通 知 で 更 新 し て いる)
          return messageOverflowMirror[ringIndex]!;
        },
      };
      // message ring の sender を event surface に統合 (Q88)。同名 in/out ペア
      // (Q87) なら既存の receive (.on) entry に send (.emit) を足し、diagnostics
      // は outbound event 側を保持する。
      const existingEntry = eventSurface[ring.name] as EventSurface<unknown> | undefined;
      if (existingEntry !== undefined) {
        existingEntry.emit = emit;
      } else {
        eventSurface[ring.name] = { emit, diagnostics } as EventSurface<unknown>;
      }
    }
  }

  // MIDI surface 構 築 (`11-midi.md` §3)。 in port = message と 同 transport で
  // `send` / `connectFromWebMIDI`、 out port = event と 同 で `onEvent`。 両 方 に
  // `diagnostics.overflowCount`。 8-byte 固 定 wire slot = midiWire codec で encode/decode。
  const midiSurface: Record<string, MidiPortSurface> = {};
  // out port (= event-like) per-port subscriber: type 別 handler set。 in port は 空。
  const midiOutSubscribers: Map<
    string,
    Map<MidiEventType, Set<(e: MidiEvent) => void>>
  > = new Map();
  const midiOutLocalTails: number[] = midiRings.map(() => 0);
  // postMessage path 用 overflow mirror (= in/out 共 用、 ring index は in/out 排 他 = 曖 昧 ナ シ)。
  const midiOverflowMirror: number[] = midiRings.map(() => 0);
  let midiRingsView: DataView | null = null;
  let midiRingsHeaderView: Int32Array | null = null;
  if (midiRingsBuffer !== null && midiRings.length > 0) {
    midiRingsView = new DataView(midiRingsBuffer);
    midiRingsHeaderView = new Int32Array(midiRingsBuffer);
  }
  const sysexContentBytes: Uint8Array | null =
    sysexContentBuffer !== null ? new Uint8Array(sysexContentBuffer) : null;

  // atTime → block-local atSample (§4.2)。 atTime 省 略 = 0 (= 次 block boundary)。
  // atTime 指 定 = now から の sample offset を 1 block 内 に clamp (= near-future の
  // sub-block accuracy、 far-future は block 先 頭 に saturate = postMessage 既 定 と zip)。
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

  // 1 つ の 8-byte wire slot を decode (= status/data1/data2 + atSample)。 sysex は
  // status 0xF0 = content から length-prefixed bytes を 読 む。 SAB poll / postMessage
  // 両 path で 共 用 (= contentBytes は SAB region or postMessage 同 梱 snapshot)。
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

  // out port subscriber に decode 済 event を dispatch (= type 一 致 handler だ け fire)。
  // main-side `MidiEvent` は atSample を 持 た ない (§2.1、 sample-offset は worklet 内 部
  // の sample-accurate gating 用 = block 完 了 後 の main に は 既 過 去) = plain event を 渡 す。
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

      // inbound (= main → worklet)。 SAB = ring に slot write + head++ (drop-oldest)、
      // postMessage = `{ kind:'midi', ringIndex, item }` 直 送。
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
        // Web MIDI の MIDIMessageEvent.data (= raw bytes) を MidiEvent に 復 元 し て send。
        // sysex (0xF0) は 末 尾 0xF7 を 含 む raw bytes を そ の ま ま data に。
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

      // outbound (= worklet → main)。 type 別 handler を 登 録、 SAB = rAF poll で drain、
      // postMessage = onMidiOutMessage で dispatch。 unsubscribe を 返 す。
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

  // SAB out-ring drain = rAF poll で WASM-mirror さ れ た SAB ring を tail→head で 消 化
  // + decode + dispatch (= event ring poll と 同 lifecycle)。 in port は skip。
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

  // rAF polling driver = 全 publish slot + 全 event ring を walk。 publish は
  // version 増 加 検 出 で subscriber fire、 event は head が main local tail を
  // 越 え た 分 を drain + per-slot handler fire。 subscribe 1 番 目 で 開 始、
  // 全 subscriber unsubscribe or dispose で 停 止 (= 既 rAF lifecycle と zip)。
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
      // worklet 側 で drop-oldest 発 動 → SAB tail 進 ん で main local tail を 越 え
      // て いる 可 能 性 = max(localTail, sabTail) で 巻 き 直 し し て drain。
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
              // typed-array field = slot の [payloadLen, payloadOffset] を 読 ん で
              // SAB content region か ら fresh typed array を slice (= §4.3)。
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
    /* v8 ignore next 1 — subscribe path 経 由 で publish / event / midi-out surface 配 線 済 = unreachable defensive */
    if (publishSharedView === null && eventRingsView === null && midiRingsView === null) return;
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
      .requestAnimationFrame;
    if (!raf) return;
    // tick 内 で disposed branch ナ シ = `dispose()` で stopRafLoop が
    // cancelAnimationFrame を 呼 び rafHandle を null に す る = 既 pending tick も
    // cancel + 再 schedule path ナ シ = defensive disposed check 不 要。
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

  // 全 publish slot + 全 event ring + 全 midi-out port の subscriber が 0 か。
  // unsubscribe で 全 て 0 に な っ た 時 に rAF polling を 止 め る 判 定 に 使 う。
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
  // as no-op)。 Normalize here so both engines see the same shape。
  const parameterData = options?.initial
    ? (Object.fromEntries(
        Object.entries(options.initial).filter(([, v]) => typeof v === "number"),
      ) as Record<string, number>)
    : undefined;

  // `outputChannelCount` is only legal when `numberOfOutputs > 0`。 With
  // zero outputs the W3C AudioWorkletNode constructor throws
  // `IndexSizeError` if `outputChannelCount.length` does not match
  // `numberOfOutputs` (= conservative engines reject `[]` mismatch even
  // though both lengths are 0)。 Omit the field for input-only / MIDI-only
  // processors instead of forcing the empty array。
  const nodeOptions: AudioWorkletNodeOptions = {
    numberOfInputs: inputs.length,
    numberOfOutputs: outputs.length,
    parameterData,
    // Hand the audio thread a pre-compiled `WebAssembly.Module` (= structured
    // cloneable per W3C wasm-web-api spec) so the worklet only needs to
    // `new WebAssembly.Instance(module)` (= no sync compile on the audio
    // thread = no first-quantum glitch potential)。
    processorOptions: {
      module: wasmModule,
      // publish slot あ り の 時 = transport mode 共 通 で descriptor + transport を
      // hand (= worklet template の initialize で receive + per-quantum 末 尾 で
      // publish copy logic 走 ら す)。 publishBuffer は SAB 時 の み hand (= postMessage
      // path で は structured clone で 別 instance に な る = mirror 不 能、 worklet
      // 側 が port.postMessage で 個 別 通 知 す る path = buffer 不 要)。
      ...(publishSlots.length > 0
        ? {
            publishSlots,
            transport: transportMode,
            ...(publishBuffer !== null ? { publishBuffer } : {}),
          }
        : {}),
      // event ring あ り の 時 = transport mode 共 通 で descriptor + transport を
      // hand。 eventRingsBuffer は SAB 時 の み hand (= postMessage path で は
      // structured clone で 別 instance に な る = mirror 不 能、 worklet 側 が
      // port.postMessage で 新 emit 分 を 個 別 配 送)。
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
      // message ring あ り の 時 = transport mode 共 通 で descriptor + transport を
      // hand。 messageRingsBuffer は SAB 時 の み hand (= postMessage path は main 側
      // が port.postMessage で 直 送、 worklet 側 が self.port.onmessage で receive
      // = buffer 自 体 不 要)。
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
      // MIDI ring あ り の 時 = descriptor + offset + transport を hand。 buffer は SAB
      // 時 の み (= postMessage path は main が `{ kind:'midi' }` 直 送 / worklet が
      // `{ kind:'midiOut' }` 配 送 = main 側 buffer 不 要)。
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
    // tripped)。 Caller never sees an `UnworkletNode`, so they cannot call
    // `dispose()` themselves — tear down the half-built node here。 MDN
    // documents that a `processorerror`-d node outputs silence for the
    // rest of its lifetime, so without this cleanup repeated retries
    // accumulate silent processor instances + open ports inside the
    // AudioContext。 Best-effort: swallow secondary errors so the original
    // failure is what surfaces to the caller。
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
  // `onError(handler)` subscribers for the node's lifetime。 docs/05-client.md
  // §2 declares `onError` as the discriminated-union surface for 4 codes
  // (`wasm-trap` / `queue-overflow` / `sab-unavailable` / `block-length-mismatch`)。
  // Phase 6 wires the forwarder skeleton — only `block-length-mismatch` (= from
  // `worklet.ts` runtime guard) and `wasm-trap` (= from `processorerror`) are
  // posted today。 `queue-overflow` / `sab-unavailable` plumbing lands when
  // the matching transports ship (= 02-messaging.md / 04-worklet-runtime.md §8)。
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
   * Set of `NodeErrorEvent.code` values the runtime currently posts。 Used
   * to drop unknown / malformed `{ kind: "error", ... }` messages instead
   * of forwarding their raw shape to subscribers as if they were typed
   * `NodeErrorEvent`s (= prevents the structured-union contract from
   * silently widening when an unrelated message slips through)。
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
    // §8 declared shape, no extra `kind`)。
    const { kind: _kind, ...rest } = data as Record<string, unknown> & { kind: "error" };
    dispatchError(rest as unknown as NodeErrorEvent);
  };
  const onErrorProcessor = (_event: Event): void => {
    // MDN documents the `processorerror` event as a plain `Event` with no
    // payload — there is no portable `.message` to read。 The structured
    // wasm-trap details (= the actual error message) come through the
    // `{ kind: "error", code: "wasm-trap", message }` path on the port。
    // This handler only fires when the audio thread couldn't post that
    // message (= constructor / process trap before the structured catch
    // ran), so emit a fixed fallback marker。
    dispatchError({
      code: "wasm-trap",
      message: "AudioWorkletProcessor reported a failure (processorerror)",
    });
  };
  node.port.addEventListener("message", onErrorMessage);
  node.addEventListener("processorerror", onErrorProcessor);

  // postMessage path 用 publish listener (= SAB unavailable 時 に worklet 側 が
  // version advance 時 に `port.postMessage({ kind: 'publish', slotIndex, valueBits,
  // sampleCounter, version })` を 投 げ る = main 側 で 即 時 mirror 更 新 + subscriber
  // dispatch。 SAB 時 は worklet が 直 接 SAB に Atomics.store す る path = listener
  // は 何 も せ ず drop)。
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

  // postMessage path 用 event listener (= SAB unavailable 時 に worklet 側 が 新
  // emit 分 を `port.postMessage({ kind: 'event', ringIndex, newSlotsBytes,
  // newSlotCount, overflowCount })` で 配 送 す る = main 側 で payload object 化 +
  // subscriber dispatch + overflowCount mirror 更 新)。 SAB 時 は drop。
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
    // overflowCount mirror 更 新 (= diagnostics.overflowCount() の read 元)
    if (typeof data.overflowCount === "number") {
      eventOverflowMirror[ringIndex] = data.overflowCount;
    }
    // slots を payload object 化 + subscriber dispatch
    if (
      data.newSlotsBytes instanceof ArrayBuffer &&
      typeof data.newSlotCount === "number" &&
      data.newSlotCount > 0
    ) {
      const subscribers = eventSubscribers.get(ring.name);
      if (!subscribers || subscribers.size === 0) return;
      const view = new DataView(data.newSlotsBytes);
      // §4.3 typed-array field 用 = worklet が 同 梱 し た content snapshot (= offset 0
      // 単 一 payload)。 slot の [payloadLen, payloadOffset] で ここ か ら slice。
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

  // postMessage path 用 message overflow listener (= SAB unavailable 時 に worklet
  // 側 WASM ring で drop-oldest 発 動 し て overflowCount が 増 え た 場 合 に
  // `port.postMessage({ kind: 'message-overflow', ringIndex, overflowCount })` で
  // 通 知 さ れ る = main 側 messageOverflowMirror を 更 新 し て diagnostics.overflowCount()
  // で read 可 能 に す る)。 SAB 時 は main 側 で 直 接 SAB header を 観 測 = drop。
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

  // postMessage path 用 MIDI outbound listener (= worklet 側 out-ring drain が
  // `{ kind:'midiOut', ringIndex, newSlotsBytes, newSlotCount, overflowCount, sysexBytes? }`
  // で 配 送 = main 側 で 各 slot を decode + type 一 致 handler に dispatch + overflow mirror 更 新)。
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

  // postMessage path 用 MIDI inbound overflow listener (= worklet 側 in-ring で
  // drop-oldest 発 動 時 に `{ kind:'midi-overflow', ringIndex, overflowCount }` で
  // 通 知 = main 側 mirror 更 新 + diagnostics.overflowCount() で read 可)。
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

  // snapshot / restore request-response (`05-client.md` §2.6 + `01-dsl.md` §8)。
  // SAB を 使 わ ず port message で 往 復 = worklet が onmessage (= render quantum 境
  // 界) で linear memory を read / write す る の で block-atomic (= §6.1)。 各 request
  // に 連 番 id を 振 り、 worklet の response を pending map で 突 き 合 わ せ て resolve。
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
    // Migrate the blob to the current schema first (`01-dsl.md` §8.3)。 A throwing
    // migrate step fails the whole restore = the live node keeps its current state。
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
    // writes state / buffer into linear memory at the quantum boundary。 dispose() /
    // processorerror reject the pending promise so a torn-down node never hangs here。
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
    // the worklet's authoritative applied report。
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

  // sab-unavailable event を 1 度 だ け fire す る pending flag (= 04-worklet-
  // runtime.md §8、 sub-phase 7.4)。 SAB available なら 不 要、 fallback 環 境 で
  // 1 番 目 の onError subscriber に 1 度 だ け 通 知 (= subscriber が createNode
  // 直 後 に subscribe で きる path を 想 定、 後 subscribe は drop)。
  // (= `disposed` latch は state surface 構 築 path で 既 上 で declare 済 = 重 複 declare せ ず)
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
      // through the disposed processor。 Upstream sources connected by the
      // user to `node.inputs.<name>` are their own to disconnect — unworklet
      // does not own the user's graph (= Q4-a / Q6: typed wrappers compose
      // with Web Audio, framework does not mutate user-constructed edges)。
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
        // subscribers torn down at dispose)。 Returning a no-op unsubscribe
        // keeps the caller's cleanup path symmetric。
        return () => {};
      }
      errorSubscribers.add(handler);
      // pending sab-unavailable event を 1 度 だ け fire (= sub-phase 7.4)。
      // SAB available 環 境 で は pendingSabUnavailable = false で 何 も し ない。
      // fallback 環 境 で 1 番 目 の subscriber に だ け notify、 後 subscribe は
      // pending flag を clear 済 で drop。
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
