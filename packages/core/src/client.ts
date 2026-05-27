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
  UnworkletNode,
} from "./types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

const moduleCache = new WeakMap<object, Set<string>>();

const addModuleOnce = async (
  context: { audioWorklet: { addModule: (url: string) => Promise<void> } },
  url: string,
): Promise<void> => {
  let registered = moduleCache.get(context as unknown as object);
  if (!registered) {
    registered = new Set();
    moduleCache.set(context as unknown as object, registered);
  }
  if (registered.has(url)) return;
  await context.audioWorklet.addModule(url);
  registered.add(url);
};

const fetchWasm = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  return new Uint8Array(await response.arrayBuffer());
};

const buildInputs = (
  node: AudioWorkletNode,
  inputs: readonly AudioPortDescriptor[],
): Record<string, { connect(source: AudioNode): void; disconnect(): void }> => {
  const result: Record<string, { connect(source: AudioNode): void; disconnect(): void }> = {};
  for (let portIdx = 0; portIdx < inputs.length; portIdx++) {
    const desc = inputs[portIdx]!;
    const idx = portIdx;
    const tracked = new Set<AudioNode>();
    result[desc.name] = {
      connect(source: AudioNode): void {
        source.connect(node, 0, idx);
        tracked.add(source);
      },
      disconnect(): void {
        for (const source of tracked) {
          try {
            source.disconnect(node, 0, idx);
          } catch {
            // Source may have been disposed externally; ignore.
          }
        }
        tracked.clear();
      },
    };
  }
  return result;
};

const buildOutputs = (
  node: AudioWorkletNode,
  outputs: readonly AudioPortDescriptor[],
): Record<string, { connect(target: AudioNode): void; disconnect(): void }> => {
  const result: Record<string, { connect(target: AudioNode): void; disconnect(): void }> = {};
  for (let portIdx = 0; portIdx < outputs.length; portIdx++) {
    const desc = outputs[portIdx]!;
    const idx = portIdx;
    result[desc.name] = {
      connect(target: AudioNode): void {
        node.connect(target, idx, 0);
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

const awaitReady = (node: AudioWorkletNode): Promise<void> =>
  new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { kind?: unknown } | null | undefined;
      if (typeof data === "object" && data !== null && data.kind === "ready") {
        node.port.removeEventListener("message", onMessage);
        resolve();
      }
    };
    node.port.addEventListener("message", onMessage);
    node.port.start();
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
  const wasmBytes = await fetchWasm(wasmUrl);

  const inputs = ns.inputs;
  const outputs = ns.outputs;
  const outputChannelCount = outputs.map((o) => o.channels);

  const node = new (
    globalThis as unknown as { AudioWorkletNode: typeof AudioWorkletNode }
  ).AudioWorkletNode(context as unknown as BaseAudioContext, processorName, {
    numberOfInputs: inputs.length,
    numberOfOutputs: outputs.length,
    outputChannelCount,
    parameterData: options?.initial as Record<string, number> | undefined,
    processorOptions: { wasm: wasmBytes },
  });

  await awaitReady(node);

  const paramDescriptors = ns.parameterDescriptors as readonly { name: string }[];
  const params = buildParams(node, paramDescriptors);

  const unworkletNode: UnworkletNode<C> = {
    node,
    inputs: buildInputs(node, inputs) as UnworkletNode<C>["inputs"],
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
    onError: () => () => {},
    __processor: undefined as unknown as C,
  };

  return unworkletNode;
}

export function inspect(_blob: Uint8Array): InspectionResult {
  return notImplemented();
}
