/**
 * Compile a processor for an AudioContext whose sample rate or render quantum
 * differs from the one its WASM was built for (`createNode`'s mismatch path).
 *
 * The build ships a compile worker next to the processor
 * (`worklet.compileWorkerUrl`, from `@unworklet/core/compile-worker`). This
 * module starts it in a page Web Worker — binaryen never runs on the main
 * thread — asks for the context's target, compiles the returned WASM bytes into
 * a `WebAssembly.Module`, and registers the returned self-contained worklet
 * module on the context from a Blob URL.
 *
 * - One compile per (worker URL, rate, quantum) per page; failures are evicted so
 *   a later call retries.
 * - At most `MAX_CONCURRENT_COMPILES` workers run at once (each loads binaryen).
 * - A worker is terminated as soon as it replies, or after `COMPILE_TIMEOUT_MS`
 *   from the request being dispatched.
 * - Each context registers each compiled module once; the Blob URL is revoked as
 *   soon as `addModule` settles.
 */

import type { WorkletNamespace } from "./types.ts";
import { makeWorkletNamespaceFromMeta, type WorkletMeta } from "./worklet.ts";

/** The context's rate and render quantum, which the WASM is compiled for. */
export type CompileTarget = {
  readonly sampleRate: number;
  readonly renderQuantumSize: number;
};

const COMPILE_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_COMPILES = 2;

type Compiled = {
  readonly wasmModule: WebAssembly.Module;
  readonly meta: WorkletMeta;
  readonly moduleSource: string;
  readonly processorName: string;
};

type WorkerReply =
  | { type: "ready" }
  | { type: "result"; wasm: Uint8Array; meta: WorkletMeta; moduleSource: string }
  | { type: "error"; message: string };

type WorkerLike = {
  addEventListener(type: "message", listener: (event: { data: WorkerReply }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  postMessage(message: unknown): void;
  terminate(): void;
};
type WorkerConstructor = new (url: string, options: { type: "module" }) => WorkerLike;

type ContextLike = { audioWorklet: { addModule: (url: string) => Promise<void> } };

/** Page-wide compiles, keyed by worker URL, rate and quantum. */
const compiles = new Map<string, Promise<Compiled>>();
/** Per-context registrations of compiled modules, keyed like `compiles`. */
const registrations = new WeakMap<object, Map<string, Promise<void>>>();

let running = 0;
const waiting: Array<() => void> = [];

/** Wait for a compile slot; resolves with the function that frees it. */
function acquireSlot(): Promise<() => void> {
  const release = (): void => {
    running--;
    waiting.shift()?.();
  };
  if (running < MAX_CONCURRENT_COMPILES) {
    running++;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      running++;
      resolve(release);
    });
  });
}

function compileInWorker(
  Worker: WorkerConstructor,
  url: string,
  target: CompileTarget,
  processorName: string,
): Promise<{ wasm: Uint8Array; meta: WorkletMeta; moduleSource: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { type: "module" });
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`the compile worker timed out after ${COMPILE_TIMEOUT_MS} ms`)),
      );
    }, COMPILE_TIMEOUT_MS);
    worker.addEventListener("message", (event) => {
      const reply = event.data;
      if (reply.type === "ready") {
        worker.postMessage({ type: "compile", id: 1, ...target, processorName });
      } else if (reply.type === "result") {
        finish(() => resolve(reply));
      } else {
        finish(() => reject(new Error(reply.message)));
      }
    });
    worker.addEventListener("error", (event) => {
      finish(() => reject(new Error(event.message ?? "the compile worker failed to start")));
    });
  });
}

function compileOnce(
  Worker: WorkerConstructor,
  url: string,
  key: string,
  target: CompileTarget,
  processorName: string,
): Promise<Compiled> {
  let pending = compiles.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const release = await acquireSlot();
      try {
        const reply = await compileInWorker(Worker, url, target, processorName);
        const wasmModule = await WebAssembly.compile(reply.wasm as BufferSource);
        return { wasmModule, meta: reply.meta, moduleSource: reply.moduleSource, processorName };
      } finally {
        release();
      }
    })();
    compiles.set(key, pending);
    pending.catch(() => compiles.delete(key));
  }
  return pending;
}

function registerOnce(context: ContextLike, key: string, moduleSource: string): Promise<void> {
  let byKey = registrations.get(context);
  if (byKey === undefined) {
    byKey = new Map();
    registrations.set(context, byKey);
  }
  let pending = byKey.get(key);
  if (pending === undefined) {
    const url = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
    pending = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    byKey.set(key, pending);
    const map = byKey;
    pending.catch(() => map.delete(key));
  }
  return pending;
}

/**
 * Compile `ns`'s processor for `target` in its compile worker and register the
 * result on `context`. Returns the namespace and WASM module to construct the
 * node with. Requires `ns.compileWorkerUrl` and `ns.processorName`.
 */
export async function compileForContext(
  context: BaseAudioContext,
  ns: WorkletNamespace,
  target: CompileTarget,
): Promise<{ ns: WorkletNamespace; wasmModule: WebAssembly.Module }> {
  const url = ns.compileWorkerUrl!;
  const { sampleRate, renderQuantumSize } = target;
  const label = `${ns.displayName ?? ns.processorName}`;
  const describe = `${sampleRate} Hz and ${renderQuantumSize}-sample render quanta`;
  const Worker = (globalThis as { Worker?: WorkerConstructor }).Worker;
  if (typeof Worker !== "function") {
    throw new Error(
      `unworklet: createNode() needs to compile ${label} for ${describe}, but Web Workers are ` +
        `unavailable here. Create the AudioContext at the rate and render quantum the processor ` +
        `was built for, or compile it for this context with \`compile\`.`,
    );
  }
  const key = `${url}|${sampleRate}|${renderQuantumSize}`;
  let compiled: Compiled;
  try {
    compiled = await compileOnce(
      Worker,
      url,
      key,
      target,
      `${ns.processorName}@${sampleRate}x${renderQuantumSize}`,
    );
  } catch (error) {
    // Every rejection here is an Error: the worker's reply, its error event, the
    // timeout, or WebAssembly.compile's CompileError.
    throw new Error(
      `unworklet: createNode() could not compile ${label} for ${describe}: ` +
        (error as Error).message,
    );
  }
  await registerOnce(context as unknown as ContextLike, key, compiled.moduleSource);
  return {
    ns: {
      ...makeWorkletNamespaceFromMeta(compiled.meta),
      processorName: compiled.processorName,
      ...(ns.displayName !== undefined ? { displayName: ns.displayName } : {}),
      bakedSampleRate: sampleRate,
      compileWorkerUrl: url,
    },
    wasmModule: compiled.wasmModule,
  };
}
