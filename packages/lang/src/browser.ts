/// <reference lib="dom" />
/**
 * `@unworklet/lang/browser` — compile a `.uwk.ts` source STRING to a playable
 * processor entirely in the browser, at runtime. This is the live-editing path:
 * the same lower → compile → worklet-module pipeline the unplugin runs at
 * build time, replayed on the fly so an edited source becomes a new processor.
 *
 *   text → lower() (sugar → core, off the bundled type snapshot)
 *        → transpile + eval → CompiledProcessor
 *        → compile() (binaryen → WASM)
 *        → emitWorkletModuleSource(meta, { runtime: inline }) + Blob URLs
 *
 * `createNode` / `replaceProcessor` accept the resulting `.worklet` namespace
 * directly. The entry is self-contained: the type snapshot and the inlined
 * worklet runtime are bundled at this package's build time (no user-side vite
 * plugin, no bundler lock-in).
 */
import { compile, emitWorkletModuleSource, extractWorkletMeta } from "@unworklet/core";
import type { CompiledProcessor } from "@unworklet/core";

import { lowerToProcessor as lowerWith } from "./eval-lowered.ts";
import type { FsSnapshot } from "./program.ts";

// Injected at build time by vite `define` (see vite.browser.config.ts): the type
// snapshot (so `lower()` runs off-disk) and a self-contained IIFE of
// `@unworklet/core/worklet` (sets `globalThis.__uwkMakeNs`, inlined into each
// worklet module so it needs no import — Safari-safe).
declare const __UWK_SNAPSHOT__: FsSnapshot;
declare const __UWK_WORKLET_RUNTIME__: string;

let counter = 0;

/**
 * Lower + evaluate a `.uwk.ts` source to a raw `CompiledProcessor` — what
 * `@unworklet/offline`'s `renderOffline` accepts directly (no worklet module /
 * Blob URLs needed for headless rendering).
 */
export function lowerToProcessor(source: string): CompiledProcessor<unknown> {
  return lowerWith(source, __UWK_SNAPSHOT__);
}

/**
 * Compile a `.uwk.ts` source string to a playable processor in the browser.
 * Pass the result straight to `createNode(ctx, proc)`.
 */
export async function compileSource(source: string): Promise<CompiledProcessor<unknown>> {
  const processor = lowerToProcessor(source);
  const { wasm } = await compile(processor);
  const meta = extractWorkletMeta(
    (processor as unknown as { graph: Parameters<typeof extractWorkletMeta>[0] }).graph,
  );
  const processorName = `uwk-runtime-${counter++}`;
  const moduleSource = emitWorkletModuleSource(meta, {
    processorName,
    runtime: { kind: "inline", code: __UWK_WORKLET_RUNTIME__ },
  });
  const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
  const wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: "application/wasm" }));
  return {
    ...(processor as object),
    worklet: {
      ...(processor as unknown as { worklet: object }).worklet,
      moduleUrl,
      wasmUrl,
      processorName,
      displayName: processorName,
    },
  } as CompiledProcessor<unknown>;
}
