/**
 * `@unworklet/core/compile-worker` — the body of a page Web Worker that compiles
 * one processor for an AudioContext whose sample rate or render quantum differs
 * from the build's (`createNode` starts it from `worklet.compileWorkerUrl`).
 *
 * The worker imports binaryen statically: a bundler's dynamic-import helper may
 * assume a document, which a worker does not have. Binaryen evaluates with a
 * top-level await, so this module's own evaluation — and the listener below —
 * comes after it; `{ type: "ready" }` tells the page the worker now listens.
 *
 * Protocol (one request per worker in `createNode`, but any number is served):
 *   page → worker  { type: "compile", id, sampleRate, renderQuantumSize, processorName }
 *   worker → page  { type: "ready" }
 *                  { type: "result", id, wasm, meta, moduleSource }   (wasm transferred)
 *                  { type: "error", id, message }                     (compile diagnostics' IDs in message)
 */

import binaryen from "binaryen";

import { compileWith } from "./compile/index.ts";
import type { CapturedGraph } from "./compile/ast.ts";
import type { CompiledProcessor } from "./types.ts";
import { emitWorkletModuleSource } from "./worklet-module.ts";
import { extractWorkletMeta, type WorkletMeta } from "./worklet.ts";

export type CompileWorkerRequest = {
  readonly type: "compile";
  readonly id: number;
  readonly sampleRate: number;
  readonly renderQuantumSize: number;
  /** `registerProcessor` key of the compiled module (unique per target). */
  readonly processorName: string;
};

export type CompileWorkerReply =
  | { readonly type: "ready" }
  | {
      readonly type: "result";
      readonly id: number;
      readonly wasm: Uint8Array;
      readonly meta: WorkletMeta;
      /** A self-contained AudioWorklet module (runtime inlined) registering `processorName`. */
      readonly moduleSource: string;
    }
  | { readonly type: "error"; readonly id: number; readonly message: string };

export type ServeCompileRequestsOptions = {
  /**
   * Source of the inline worklet runtime (the default export of
   * `@unworklet/core/worklet-runtime`), embedded in every compiled module: a
   * Blob module cannot import, so the runtime travels inside it.
   */
  readonly workletRuntime: string;
};

/** The two members of `DedicatedWorkerGlobalScope` this module uses. */
type WorkerScope = {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: CompileWorkerReply, transfer?: ArrayBuffer[]): void;
};

const isCompileRequest = (data: unknown): data is CompileWorkerRequest =>
  typeof data === "object" && data !== null && (data as { type?: unknown }).type === "compile";

/**
 * Serve compile requests for `processor` in the current worker. Call it once at
 * the top level of the worker module.
 */
export function serveCompileRequests(
  processor: CompiledProcessor<unknown>,
  options: ServeCompileRequestsOptions,
): void {
  const scope = globalThis as unknown as WorkerScope;
  scope.addEventListener("message", (event) => {
    const request = event.data;
    if (!isCompileRequest(request)) return;
    const { id, sampleRate, renderQuantumSize, processorName } = request;
    let reply: CompileWorkerReply;
    try {
      const result = compileWith(binaryen, processor, { sampleRate, renderQuantumSize });
      // The worklet must run on the metadata of the graph that produced these bytes:
      // the I/O scratch follows the quantum and rate-sized buffers move later regions.
      const meta = extractWorkletMeta(result.graph as unknown as CapturedGraph);
      const moduleSource = emitWorkletModuleSource(meta, {
        processorName,
        runtime: { kind: "inline", code: options.workletRuntime },
      });
      reply = { type: "result", id, wasm: result.wasm, meta, moduleSource };
    } catch (error) {
      scope.postMessage({
        type: "error",
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    scope.postMessage(reply, [reply.wasm.buffer as ArrayBuffer]);
  });
  scope.postMessage({ type: "ready" });
}
