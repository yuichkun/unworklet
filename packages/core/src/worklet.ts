/**
 * `CompiledProcessor.worklet` 関数 namespace の 中身 (= `01-dsl.md` §11、
 * `04-worklet-runtime.md` §2、 Q80)。
 *
 * `makeWorkletNamespace(graph)` は per-processor closure を 返す。 中身 3 件:
 *
 * - `initialize(self, opts)` — `opts.processorOptions.wasm` の bytes を sync
 *   path で 即 instantiate (= `new WebAssembly.Module` / `new WebAssembly.Instance`
 *   は AudioWorkletGlobalScope + Node test の 両 環境 で 同 等 に 動 く)、
 *   driver state を `self` の internal symbol 経 由 で 保 存、 `port.postMessage`
 *   で readiness ack。
 * - `process(self, inputs, outputs, parameters)` — `04-worklet-runtime.md` §2
 *   step 順 で 走 る: block-length guard (= Q75) → input/param marshal → WASM
 *   process → output marshal → return true。
 * - `parameterDescriptors` — graph 内 の `param` declaration を Web Audio の
 *   `AudioParamDescriptor` 形 に 変 換。
 *
 * 自 動 register path (= vite-plugin が emit する worklet JS template) と
 * escape hatch path (= user 自 前 の `class extends AudioWorkletProcessor`、
 * Q80) の 両 方 が こ の 関 数 namespace を 共 通 基 盤 と し て 使 う。
 */

import type { AudioPortDecl, CapturedGraph, ParamDecl } from "./compile/ast.ts";
import { layout, type Layout } from "./compile/layout.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import type { WorkletNamespace } from "./types.ts";

/**
 * Metadata bundle that fully describes a processor's worklet-side runtime
 * shape — everything needed to build a `WorkletNamespace` without
 * re-evaluating the authoring source。 The vite-plugin computes this at
 * build / dev time from `compile(processor)` and inlines it (as JSON) into
 * the emitted worklet entry, so `audioWorklet.addModule()` only ever loads
 * a runtime-only artifact (= no `?worklet` virtual ever re-runs `defineProcessor`
 * inside `AudioWorkletGlobalScope`)。
 */
export type WorkletMeta = {
  readonly layout: Layout;
  readonly audioInputs: readonly AudioPortDecl[];
  readonly audioOutputs: readonly AudioPortDecl[];
  readonly params: readonly ParamDecl[];
};

export function extractWorkletMeta(graph: CapturedGraph): WorkletMeta {
  return {
    layout: layout(graph),
    audioInputs: graph.declarations.filter((d): d is AudioPortDecl => d.kind === "audioInput"),
    audioOutputs: graph.declarations.filter((d): d is AudioPortDecl => d.kind === "audioOutput"),
    params: graph.declarations.filter((d): d is ParamDecl => d.kind === "param"),
  };
}

const BYTES_PER_F32 = 4;
const CHANNEL_STRIDE_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

const STATE_KEY = Symbol("unworklet.workletState");
/**
 * `initialize(self, opts)` was entered at least once。 Used by `process` to
 * distinguish two failure modes when no state is attached to `self`:
 *
 *   - `INIT_CALLED_KEY === true` AND no state → initialize ran but threw
 *     before storing state (= init-error already posted at handshake time)
 *   - `INIT_CALLED_KEY === undefined` AND no state → init was never called
 *     (= path β escape hatch and the author forgot
 *     `def.worklet.initialize(this, opts)` in their constructor — Q80)
 *
 * The second case has no compile-time check (custom class lives in user
 * code), so the runtime posts `worklet-initialize-not-called` once and
 * keeps emitting silence — fail-fast signal to main without throwing on
 * the audio thread (= `00-foundations.md` §5.1 invariant 3)。
 */
const INIT_CALLED_KEY = Symbol("unworklet.initCalled");
const INIT_NOT_CALLED_POSTED_KEY = Symbol("unworklet.initNotCalledPosted");

/**
 * Per-instance worklet state cached on the AudioWorkletProcessor `self`。
 * All `Float32Array` views over WASM linear memory are pre-bound during
 * `initialize(...)` and reused on every render quantum, because
 * `00-foundations.md` §5.1 forbids allocations / GC pressure on the audio
 * thread。 unworklet's WASM module never calls `memory.grow` (= the layout
 * sizing is computed at compile time)、 so these views stay valid for the
 * processor's lifetime — they would otherwise need to be re-bound on every
 * growth event, since growth detaches the backing ArrayBuffer。
 */
type WorkletState = {
  readonly process: () => void;
  readonly audioInputs: readonly AudioPortDecl[];
  readonly audioOutputs: readonly AudioPortDecl[];
  readonly params: readonly ParamDecl[];
  /** Index-aligned with `audioInputs`; inner array is per-channel views。 */
  readonly inputViews: readonly Float32Array[][];
  /** Index-aligned with `audioOutputs`。 */
  readonly outputViews: readonly Float32Array[][];
  /** Index-aligned with `params`。 */
  readonly paramViews: readonly Float32Array[];
  /**
   * Latched once a WASM trap escapes `state.process()`。 Subsequent quanta
   * emit silence and skip the WASM call so a single trap does not get
   * re-posted every render quantum (= main receives one `wasm-trap` event
   * and the node keeps outputting silence, per docs/05-client.md §4)。
   */
  failed: boolean;
};

type SelfWithState = {
  port: { postMessage: (m: unknown) => void };
  [STATE_KEY]?: WorkletState;
  [INIT_CALLED_KEY]?: boolean;
  [INIT_NOT_CALLED_POSTED_KEY]?: boolean;
};

type ProcessorOptionsBag = {
  processorOptions?: { wasm?: Uint8Array };
};

const fillOutputsSilent = (outputs: Float32Array[][]): void => {
  for (const port of outputs) {
    for (const channel of port) {
      channel.fill(0);
    }
  }
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function makeWorkletNamespace(graph: CapturedGraph): WorkletNamespace {
  return makeWorkletNamespaceFromMeta(extractWorkletMeta(graph));
}

export function makeWorkletNamespaceFromMeta(meta: WorkletMeta): WorkletNamespace {
  const lay = meta.layout;
  const audioInputs = meta.audioInputs;
  const audioOutputs = meta.audioOutputs;
  const params = meta.params;

  const parameterDescriptors = params.map((p) => ({
    name: p.name,
    defaultValue: p.default,
    minValue: p.min,
    maxValue: p.max,
    automationRate: p.automationRate,
  }));

  const inputDescriptors = audioInputs.map((p) => ({ name: p.name, channels: p.channels }));
  const outputDescriptors = audioOutputs.map((p) => ({ name: p.name, channels: p.channels }));

  const initialize: WorkletNamespace["initialize"] = (...args) => {
    const self = args[0] as SelfWithState;
    const opts = (args[1] ?? {}) as ProcessorOptionsBag;
    // Mark `initialize` as entered so `process()` can tell init-failed
    // (= flag set but no state) from init-never-called (= flag unset),
    // and surface the latter via `worklet-initialize-not-called`。
    self[INIT_CALLED_KEY] = true;
    try {
      const wasm = opts.processorOptions?.wasm;
      if (!wasm) {
        throw new Error(
          "unworklet: `initialize(self, opts)` requires `opts.processorOptions.wasm` " +
            "(= the compiled WASM bytes handed off from main thread via AudioWorkletNodeOptions)",
        );
      }
      const wasmModule = new WebAssembly.Module(wasm.buffer as ArrayBuffer);
      const instance = new WebAssembly.Instance(wasmModule);
      const memory = instance.exports["memory"] as WebAssembly.Memory;
      const procFn = instance.exports["process"] as () => void;

      // Pre-bind one Float32Array view per (port, channel) and per param。
      // Reused on every `process()` call to keep the audio thread alloc-free
      // (= `00-foundations.md` §5.1)。 Memory.grow is never invoked by
      // generated WASM = the views stay valid for the processor's lifetime。
      const inputViews: Float32Array[][] = [];
      for (const decl of audioInputs) {
        const portBase = lay.regions.ioScratch.inputs[decl.name]!;
        const channels: Float32Array[] = [];
        for (let c = 0; c < decl.channels; c++) {
          const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
          channels.push(new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK));
        }
        inputViews.push(channels);
      }

      const outputViews: Float32Array[][] = [];
      for (const decl of audioOutputs) {
        const portBase = lay.regions.ioScratch.outputs[decl.name]!;
        const channels: Float32Array[] = [];
        for (let c = 0; c < decl.channels; c++) {
          const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
          channels.push(new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK));
        }
        outputViews.push(channels);
      }

      const paramViews: Float32Array[] = [];
      for (const decl of params) {
        const paramBase = lay.regions.ioScratch.params[decl.name]!;
        paramViews.push(new Float32Array(memory.buffer, paramBase, SAMPLES_PER_BLOCK));
      }

      (self as SelfWithState)[STATE_KEY] = {
        process: procFn,
        audioInputs,
        audioOutputs,
        params,
        inputViews,
        outputViews,
        paramViews,
        failed: false,
      };

      self.port.postMessage({ kind: "ready" });
    } catch (err) {
      // Surface the failure via a structured handshake message so
      // `createNode()` on main can reject with context (= debug clarity
      // beyond `processorerror`, which carries no payload per MDN)。
      // Do NOT rethrow: the audio thread must not propagate exceptions
      // (= `00-foundations.md` §5.1 invariant 3)、 subsequent `process()`
      // calls will see no state and emit silence。
      self.port.postMessage({
        kind: "init-error",
        message: errorMessage(err),
      });
    }
  };

  const process: WorkletNamespace["process"] = (...args): boolean => {
    const self = args[0] as SelfWithState;
    const inputs = args[1] as Float32Array[][];
    const outputs = args[2] as Float32Array[][];
    const parameters = args[3] as Record<string, Float32Array>;

    const state = (self as SelfWithState)[STATE_KEY];
    if (!state) {
      // No state attached = two distinct paths. Post the path-β-specific
      // signal once if `initialize` was never called (= author forgot
      // `def.worklet.initialize(this, opts)`); otherwise stay silent
      // (= initialize ran but threw, in which case `init-error` was
      // already posted during the createNode handshake)。 Either way:
      // emit silence、 `return true` to keep the AudioWorkletProcessor
      // alive、 no throw on the audio thread。
      const initCalled = self[INIT_CALLED_KEY] === true;
      if (!initCalled && !self[INIT_NOT_CALLED_POSTED_KEY]) {
        self.port.postMessage({ kind: "error", code: "worklet-initialize-not-called" });
        self[INIT_NOT_CALLED_POSTED_KEY] = true;
      }
      fillOutputsSilent(outputs);
      return true;
    }
    if (state.failed) {
      // A previous quantum trapped inside `state.process()`. Per
      // docs/05-client.md §4 the node stays connected + outputs silence
      // for the rest of its lifetime — the wasm-trap message was already
      // posted once, do not flood the port。
      fillOutputsSilent(outputs);
      return true;
    }

    // 04-worklet-runtime.md §3 / Q75 — block-length runtime guard.
    const firstOut = outputs[0]?.[0];
    if (firstOut && firstOut.length !== SAMPLES_PER_BLOCK) {
      fillOutputsSilent(outputs);
      self.port.postMessage({
        kind: "error",
        code: "block-length-mismatch",
        expected: SAMPLES_PER_BLOCK,
        received: firstOut.length,
      });
      return true;
    }

    // Marshal inputs into linear memory ioScratch.inputs[port][channel]。
    // All views were pre-bound in `initialize` = no Float32Array allocation
    // on the audio thread。
    const inputViews = state.inputViews;
    for (let portIdx = 0; portIdx < state.audioInputs.length; portIdx++) {
      const decl = state.audioInputs[portIdx]!;
      const portInput = inputs[portIdx] ?? [];
      const portViews = inputViews[portIdx]!;
      for (let c = 0; c < decl.channels; c++) {
        const view = portViews[c]!;
        const src = portInput[c];
        if (src && src.length === SAMPLES_PER_BLOCK) {
          view.set(src);
        } else {
          view.fill(0);
        }
      }
    }

    // Marshal parameters into linear memory ioScratch.params[name]。
    // AudioWorklet hands us length 0 (= no automation, use declared default),
    // 1 (= k-rate or unchanged a-rate, broadcast), or SAMPLES_PER_BLOCK
    // (= per-sample a-rate). 08-deployment.md §2 A3 unifies them at this seam.
    const paramViews = state.paramViews;
    for (let i = 0; i < state.params.length; i++) {
      const decl = state.params[i]!;
      const view = paramViews[i]!;
      const data = parameters[decl.name];
      if (!data || data.length === 0) {
        view.fill(decl.default);
      } else if (data.length === 1) {
        view.fill(data[0]!);
      } else {
        view.set(data);
      }
    }

    try {
      state.process();
    } catch (err) {
      // WASM trap during process() (= div-by-zero, OOB memory access,
      // unreachable instruction, etc。 V8 surfaces these as JS exceptions
      // of `WebAssembly.RuntimeError` per the WebAssembly spec)。 Latch
      // failed state so subsequent quanta short-circuit, emit silence for
      // this quantum, and surface the trap to main via `onError` channel。
      // Keep returning true so the AudioWorkletProcessor stays alive (=
      // node stays connected per docs/05-client.md §4)。
      state.failed = true;
      fillOutputsSilent(outputs);
      self.port.postMessage({
        kind: "error",
        code: "wasm-trap",
        message: errorMessage(err),
      });
      return true;
    }

    // Marshal outputs from linear memory ioScratch.outputs[port][channel]。
    const outputViews = state.outputViews;
    for (let portIdx = 0; portIdx < state.audioOutputs.length; portIdx++) {
      const decl = state.audioOutputs[portIdx]!;
      const portOutput = outputs[portIdx] ?? [];
      const portViews = outputViews[portIdx]!;
      for (let c = 0; c < decl.channels; c++) {
        const view = portViews[c]!;
        const dest = portOutput[c];
        if (dest) {
          dest.set(view);
        }
      }
    }

    return true;
  };

  return {
    initialize,
    process,
    parameterDescriptors,
    inputs: inputDescriptors,
    outputs: outputDescriptors,
  };
}
