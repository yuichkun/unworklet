/**
 * Main-thread client surface (`05-client.md` §1 + §2 + §2.6).
 *
 * - `createNode(context, processor, options)` — wraps a precompiled
 *   `AudioWorkletNode`. The WASM binary is supplied via `options.wasm`
 *   (α-2: options-bag WASM hand-off). `createNode` is the AudioWorklet
 *   binding surface only — it does not call `compile`.
 * - `inspect(blob)` — non-realtime free function over a snapshot blob
 *   (= Q48 shape rule: blob-only operations are free functions).
 */

import type {
  CompiledProcessor,
  CreateNodeOptions,
  InspectionResult,
  UnworkletNode,
} from "./types.ts";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export function createNode<C>(
  _context: BaseAudioContext,
  _processor: CompiledProcessor<C>,
  _options: CreateNodeOptions<C>,
): Promise<UnworkletNode<C>> {
  return notImplemented();
}

export function inspect(_blob: Uint8Array): InspectionResult {
  return notImplemented();
}
