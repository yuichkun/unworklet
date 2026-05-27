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
  InspectionResult,
  NodeErrorEvent,
  UnworkletNode,
} from "./types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

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
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      node.port.removeEventListener("message", onMessage);
      node.removeEventListener("processorerror", onProcessorError);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent): void => {
      if (settled) return;
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
      if (settled) return;
      cleanup();
      // `processorerror` carries no payload per MDN — surface what we can。
      const errEvent = event as ErrorEvent;
      const message = errEvent.message || "AudioWorkletProcessor constructor threw";
      reject(new Error(`unworklet: processorerror during init — ${message}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
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
    processorOptions: { module: wasmModule },
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

  // `disposed` latch = once `.dispose()` runs, the node is logically dead
  // (= docs/05-client.md §4 「all resources torn down」)。 Late subscribers
  // would otherwise pile into `errorSubscribers` after `clear()` ran +
  // never fire (= silent closure leak) — gate the add path with this flag。
  let disposed = false;

  const unworkletNode: UnworkletNode<C> = {
    node,
    inputs: inputHandles,
    outputs: buildOutputs(node, outputs) as UnworkletNode<C>["outputs"],
    params,
    state: {},
    events: {},
    messages: {},
    midi: {},
    diagnostics: { transport: "postMessage" },
    snapshot: notImplemented as unknown as UnworkletNode<C>["snapshot"],
    restore: notImplemented as unknown as UnworkletNode<C>["restore"],
    dispose(): void {
      if (disposed) return;
      disposed = true;
      node.port.removeEventListener("message", onErrorMessage);
      node.removeEventListener("processorerror", onErrorProcessor);
      errorSubscribers.clear();
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
