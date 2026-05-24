/**
 * `replaceProcessor(oldNode, newProcessor)` — raw primitive for swapping
 * a running processor's WASM implementation while carrying state forward
 * via the existing snapshot + migration-chain machinery (`05-client.md`
 * §8 + `decisions-log.md` Q50).
 *
 * Internally:
 *   1. `oldNode.snapshot()` captures current state.
 *   2. `compile(newProcessor)` emits the new WASM binary.
 *   3. A new `AudioWorkletNode` is registered under a fresh unique name
 *      (Web Audio's `registerProcessor` rejects duplicates).
 *   4. `restore(blob)` runs against the new instance, executing the
 *      migration chain.
 *
 * The returned `node` is always a fresh `UnworkletNode<New>` typed against
 * the new processor's declarations. Disconnect / connect / crossfade are
 * the caller's responsibility — `replaceProcessor` does not touch the
 * audio graph topology.
 */

import type { CompiledProcessor, ReplaceResult, UnworkletNode } from "./types.ts";

export function replaceProcessor<Old, New>(
  _oldNode: UnworkletNode<Old>,
  _newProcessor: CompiledProcessor<New>,
): Promise<ReplaceResult<New>> {
  throw new Error("not implemented");
}
