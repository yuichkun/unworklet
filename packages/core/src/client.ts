/**
 * Main-thread client surface (`05-client.md` §1 + §2)。 Phase 6 A-3 fill:
 *
 * - `createNode(context, processor, options?)` — `?worklet` 経 由 で
 *   augment さ れ た CompiledProcessor を 受 け 取 り、 `addModule` +
 *   `fetch(wasmUrl)` + `new AudioWorkletNode(...)` + readiness handshake
 *   を 経 て typed `UnworkletNode<C>` を 返 す。 audioWorklet.addModule
 *   は (context, moduleUrl) ご と に cache し て 二 重 register を 防 ぐ。
 * - `UnworkletNode<C>` 最 小 surface = `node` / `inputs.<name>` /
 *   `outputs.<name>` / `params.<name>` / `dispose()` (= Phase 6 範 囲)。
 *   `state` / `events` / `messages` / `midi` / `snapshot` / `restore` /
 *   `onError` / `diagnostics` は 後 続 phase で fill す る stub。
 * - `inspect(blob)` — non-realtime free function (Q48)、 Phase 11 fill。
 */

import type {
  AudioPortDescriptor,
  CompiledProcessor,
  CreateNodeOptions,
  EventSubscriber,
  InspectionResult,
  MessageSender,
  NodeErrorEvent,
  ScalarType,
  StateValueProxy,
  UnworkletNode,
} from "./types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

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
  const eventSurface: Record<string, EventSubscriber<unknown>> = {};
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
      };
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
  const messageSurface: Record<string, MessageSender<unknown>> = {};
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
                  const src = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                  const capacity = ring.payloadContent?.capacity ?? 0;
                  const contentBase = messageContentSabOffsets[i]!;
                  let cursor = messageContentCursors[i]!;
                  if (cursor + src.byteLength > capacity) cursor = 0;
                  messageContentView.set(src, contentBase + cursor);
                  messageRingsView.setUint32(byteOffset, src.byteLength, true);
                  messageRingsView.setUint32(byteOffset + 4, cursor, true);
                  messageContentCursors[i] = cursor + src.byteLength;
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
      const senderWithDiag = Object.assign(sender as (payload: unknown) => void, {
        diagnostics: {
          overflowCount(): number {
            if (isSab && messageRingsHeaderView !== null) {
              return Atomics.load(messageRingsHeaderView, overflowWordIdx);
            }
            // postMessage path = mirror か ら read (= worklet が message-overflow
            // 通 知 で 更 新 し て いる)
            return messageOverflowMirror[ringIndex]!;
          },
        },
      }) as MessageSender<unknown>;
      messageSurface[ring.name] = senderWithDiag;
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
            payload[field.name] = readEventFieldValue(
              eventRingsView,
              fieldByteOffset,
              field.wireType,
            );
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
    /* v8 ignore next 1 — subscribe path 経 由 で publish or event surface 配 線 済 = unreachable defensive */
    if (publishSharedView === null && eventRingsView === null) return;
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
      .requestAnimationFrame;
    if (!raf) return;
    // tick 内 で disposed branch ナ シ = `dispose()` で stopRafLoop が
    // cancelAnimationFrame を 呼 び rafHandle を null に す る = 既 pending tick も
    // cancel + 再 schedule path ナ シ = defensive disposed check 不 要。
    const tick = (): void => {
      pollPublishSlots();
      pollEventRings();
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

  // 全 publish slot + 全 event ring の subscriber が 0 か。 unsubscribe で 全 て 0 に
  // な っ た 時 に rAF polling を 止 め る 判 定 に 使 う。
  function hasAnySubscribers(): boolean {
    for (const subs of stateSubscribers.values()) {
      if (subs.size > 0) return true;
    }
    for (const subs of eventSubscribers.values()) {
      if (subs.size > 0) return true;
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
      for (let k = 0; k < data.newSlotCount; k++) {
        const slotByteOffset = k * ring.slotSize;
        const payload: Record<string, unknown> = {};
        for (const field of ring.fields) {
          payload[field.name] = readEventFieldValue(
            view,
            slotByteOffset + field.offsetInSlot,
            field.wireType,
          );
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

  const { handles: inputHandles, proxies: inputProxies } = buildInputProxies(context, node, inputs);

  // sab-unavailable event を 1 度 だ け fire す る pending flag (= 04-worklet-
  // runtime.md §8、 sub-phase 7.4)。 SAB available なら 不 要、 fallback 環 境 で
  // 1 番 目 の onError subscriber に 1 度 だ け 通 知 (= subscriber が createNode
  // 直 後 に subscribe で きる path を 想 定、 後 subscribe は drop)。
  // (= `disposed` latch は state surface 構 築 path で 既 上 で declare 済 = 重 複 declare せ ず)
  let pendingSabUnavailable = !sabAvailable;

  const unworkletNode: UnworkletNode<C> = {
    node,
    inputs: inputHandles,
    outputs: buildOutputs(node, outputs) as UnworkletNode<C>["outputs"],
    params,
    state: stateSurface,
    events: eventSurface,
    messages: messageSurface,
    midi: {},
    diagnostics: { transport: transportMode },
    snapshot: notImplemented as unknown as UnworkletNode<C>["snapshot"],
    restore: notImplemented as unknown as UnworkletNode<C>["restore"],
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopRafLoop();
      node.port.removeEventListener("message", onErrorMessage);
      node.port.removeEventListener("message", onPublishMessage);
      node.port.removeEventListener("message", onEventMessage);
      node.port.removeEventListener("message", onMessageOverflowMessage);
      node.removeEventListener("processorerror", onErrorProcessor);
      errorSubscribers.clear();
      for (const subs of stateSubscribers.values()) subs.clear();
      for (const subs of eventSubscribers.values()) subs.clear();
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

  return unworkletNode;
}

export function inspect(_blob: Uint8Array): InspectionResult {
  return notImplemented();
}
