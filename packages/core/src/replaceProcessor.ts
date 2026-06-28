/**
 * `replaceProcessor(oldNode, newProcessor)` — raw primitive for swapping a
 * running processor's WASM implementation while carrying state forward via the
 * existing snapshot + migration-chain machinery (`05-client.md` §8 +
 * `decisions-log.md` Q50).
 *
 * Steps (`05-client.md` §8.2):
 *   1. `oldNode.snapshot()` captures the running state into a blob.
 *   2. `createNode(context, newProcessor)` registers the new processor's module
 *      + instantiates a fresh `AudioWorkletNode`. A distinct registration name
 *      (fresh `moduleUrl` / `processorName`) is the new processor's own — for a
 *      genuinely different processor it is naturally distinct; for live-coding /
 *      HMR of the SAME source the versioned URL is supplied by the bundler
 *      integration (`@unworklet/unplugin`), which `replaceProcessor` does not
 *      orchestrate (Q50).
 *   3. `restore(blob)` runs against the new instance, executing the migration
 *      chain (Q45).
 *
 * The returned `node` is always a fresh `UnworkletNode<New>` typed against the
 * new processor's declarations — for both the `ok` and `!ok` outcomes (a failed
 * migration still yields a running node on declaration defaults). Disconnect /
 * connect / crossfade are the caller's responsibility; `replaceProcessor` does
 * not touch the audio-graph topology (`05-client.md` §8.3).
 */

import { createNode } from "./client.ts";
import type { CompiledProcessor, ReplaceResult, UnworkletNode } from "./types.ts";

/**
 * Each call adds one entry to the `AudioWorkletGlobalScope` registered-processor
 * table, which Web Audio cannot unload before the `AudioContext` is destroyed.
 * The first call that crosses this count fires a single one-shot warning per
 * `AudioContext` (= not once per subsequent call, `05-client.md` §8.5, Q63).
 */
const REPLACE_WARN_THRESHOLD = 50;
const replaceCounts = new WeakMap<BaseAudioContext, number>();

export async function replaceProcessor<Old, New>(
  oldNode: UnworkletNode<Old>,
  newProcessor: CompiledProcessor<New>,
): Promise<ReplaceResult<New>> {
  const context = oldNode.node.context;
  const count = (replaceCounts.get(context) ?? 0) + 1;
  replaceCounts.set(context, count);
  // Fire only on the first call that crosses the threshold (= once), not on every
  // call beyond it — repeated warnings on each subsequent swap are just noise.
  if (count === REPLACE_WARN_THRESHOLD + 1) {
    console.warn(
      "unworklet: replaceProcessor has been called more than 50 times on this AudioContext. " +
        "Web Audio cannot unload old WASM modules; create a new AudioContext if memory growth matters.",
    );
  }
  // 1. capture the running state before standing up the replacement.
  const blob = await oldNode.snapshot();
  // 2. register + instantiate the new processor (createNode caches addModule per
  //    moduleUrl, so a fresh module URL is what loads new code — see Q50).
  const node = await createNode(context, newProcessor);
  // 3. carry state forward through the migration chain.
  const result = await node.restore(blob);
  return { ...result, node };
}
