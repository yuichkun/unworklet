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

  // publish slot 1 つ あ た り 12 byte (= 4 byte publishShared + 8 byte publishCounters)、
  // SAB allocate or fallback Uint8Array allocate (= postMessage transfer 用)。
  // publishSlots ゼ ロ なら ナ シ で OK = processorOptions に も hand し な い。
  const publishBufferByteLength = publishSlots.length * 12;
  let publishBuffer: SharedArrayBuffer | ArrayBuffer | null = null;
  if (publishBufferByteLength > 0) {
    publishBuffer = sabAvailable
      ? new SharedArrayBuffer(publishBufferByteLength)
      : new ArrayBuffer(publishBufferByteLength);
  }

  // event ring buffer SAB allocate (= sub-phase 7.6 commit 5b)。 1 SAB に 全 event
  // ring を 連 続 で 配 置 = per-ring SAB 内 offset = declaration 順 累 計 (= main /
  // worklet で 同 path で 計 算)。 ring 1 個 あ た り = header 12 + capacity × slotSize。
  // event ナ シ なら ゼ ロ = processorOptions に hand し な い。
  let eventRingsByteLength = 0;
  const eventRingSabOffsets: number[] = [];
  for (const ring of eventRings) {
    eventRingSabOffsets.push(eventRingsByteLength);
    eventRingsByteLength += 12 + ring.capacity * ring.slotSize;
  }
  let eventRingsBuffer: SharedArrayBuffer | ArrayBuffer | null = null;
  if (eventRingsByteLength > 0) {
    eventRingsBuffer = sabAvailable
      ? new SharedArrayBuffer(eventRingsByteLength)
      : new ArrayBuffer(eventRingsByteLength);
  }

  // message ring buffer SAB allocate (= sub-phase 7.7d)。 event ring と zip pattern。
  // event = worklet → main、 message = main → worklet で push 方 向 が 逆 = main 側
  // が SAB に push + worklet 側 が SAB → WASM mirror で drain (= sub-phase 7.7e
  // で main sender、 sub-phase 7.7d で worklet side mirror logic を fill)。
  let messageRingsByteLength = 0;
  const messageRingSabOffsets: number[] = [];
  for (const ring of messageRings) {
    messageRingSabOffsets.push(messageRingsByteLength);
    messageRingsByteLength += 12 + ring.capacity * ring.slotSize;
  }
  let messageRingsBuffer: SharedArrayBuffer | ArrayBuffer | null = null;
  if (messageRingsByteLength > 0) {
    messageRingsBuffer = sabAvailable
      ? new SharedArrayBuffer(messageRingsByteLength)
      : new ArrayBuffer(messageRingsByteLength);
  }

  // main 側 state surface 構 築 = publishBuffer を Int32Array view + 各 slot で
  // `.value` getter (= 型 別 reinterpret) + `.subscribe(handler)` (= rAF polling
  // driver で version 増 加 を 検 出 + handler fire)。
  const stateSurface: Record<string, StateValueProxy<unknown>> = {};
  const stateSubscribers: Map<string, Set<(value: unknown) => void>> = new Map();
  const lastSeenVersions: number[] = publishSlots.map(() => 0);
  let rafHandle: number | null = null;
  let disposed = false;
  let publishSharedView: Int32Array | null = null;
  if (publishBuffer !== null && publishSlots.length > 0) {
    publishSharedView = new Int32Array(publishBuffer);
    for (let i = 0; i < publishSlots.length; i++) {
      const slot = publishSlots[i]!;
      const valueSlotIdx = i * 3;
      const subscribers = new Set<(value: unknown) => void>();
      stateSubscribers.set(slot.name, subscribers);
      stateSurface[slot.name] = {
        get value() {
          const bits =
            transportMode === "sab"
              ? Atomics.load(publishSharedView!, valueSlotIdx)
              : publishSharedView![valueSlotIdx]!;
          return convertStateValue(bits, slot.type);
        },
        subscribe(handler) {
          subscribers.add(handler);
          ensureRafLoopRunning();
          return () => {
            subscribers.delete(handler);
          };
        },
      };
    }
  }

  // event ring surface 構 築 (= sub-phase 7.6 commit 6)。 worklet 側 が SAB に
  // mirror し た event ring を main 側 rAF polling で drain + 各 slot を per-field
  // reinterpret し て handler に hand。 head / tail / overflowCount は SAB 内 で
  // Atomics 経 由 で 観 測、 main 側 の tail は drain ご と に 進 め る (= worklet
  // 側 は SAB tail を 読 ま な い path = 衝 突 ナ シ)。
  const eventSurface: Record<string, EventSubscriber<unknown>> = {};
  const eventSubscribers: Map<string, Set<(payload: Record<string, unknown>) => void>> = new Map();
  const eventLocalTails: number[] = eventRings.map(() => 0);
  let eventRingsView: DataView | null = null;
  let eventRingsHeaderView: Int32Array | null = null;
  if (eventRingsBuffer !== null && eventRings.length > 0) {
    eventRingsView = new DataView(eventRingsBuffer);
    eventRingsHeaderView = new Int32Array(eventRingsBuffer);
    for (let i = 0; i < eventRings.length; i++) {
      const ring = eventRings[i]!;
      const subscribers = new Set<(payload: Record<string, unknown>) => void>();
      eventSubscribers.set(ring.name, subscribers);
      const sabOffset = eventRingSabOffsets[i]!;
      const overflowSabWordIdx = (sabOffset + 8) >>> 2;
      eventSurface[ring.name] = {
        on(handler) {
          subscribers.add(handler as (payload: Record<string, unknown>) => void);
          ensureRafLoopRunning();
          return () => {
            subscribers.delete(handler as (payload: Record<string, unknown>) => void);
          };
        },
        diagnostics: {
          overflowCount(): number {
            if (eventRingsHeaderView === null) return 0;
            return transportMode === "sab"
              ? Atomics.load(eventRingsHeaderView, overflowSabWordIdx)
              : eventRingsHeaderView[overflowSabWordIdx]!;
          },
        },
      };
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
      // publish slot あ り の 時 だ け buffer / publishSlots を hand (= worklet
      // template の initialize で receive + per-quantum 末 尾 で copy logic 経 由、
      // sub-phase 7.4 後 続 commit で fill)。 publish ゼ ロ なら 既 path 維 持。
      ...(publishBuffer !== null ? { publishBuffer, publishSlots, transport: transportMode } : {}),
      // event ring あ り の 時 だ け eventRingsBuffer + descriptor + sabOffsets を hand
      // (= sub-phase 7.6 commit 5b)。 worklet template の initialize で receive +
      // per-quantum 末 尾 で WASM → SAB copy logic (= commit 5c で fill)。
      ...(eventRingsBuffer !== null
        ? {
            eventRingsBuffer,
            eventRings,
            eventRingSabOffsets,
            transport: transportMode,
          }
        : {}),
      // message ring あ り の 時 だ け messageRingsBuffer + descriptor + sabOffsets を
      // hand (= sub-phase 7.7d)。 worklet template の initialize で receive +
      // per-quantum 開 始 で SAB → WASM mirror logic (= sub-phase 7.7d で fill)。
      ...(messageRingsBuffer !== null
        ? {
            messageRingsBuffer,
            messageRings,
            messageRingSabOffsets,
            transport: transportMode,
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
    messages: {},
    midi: {},
    diagnostics: { transport: transportMode },
    snapshot: notImplemented as unknown as UnworkletNode<C>["snapshot"],
    restore: notImplemented as unknown as UnworkletNode<C>["restore"],
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopRafLoop();
      node.port.removeEventListener("message", onErrorMessage);
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
