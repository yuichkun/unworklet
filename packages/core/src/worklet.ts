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

const BYTES_PER_F32 = 4;
const CHANNEL_STRIDE_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

const STATE_KEY = Symbol("unworklet.workletState");

type WorkletState = {
  readonly memory: WebAssembly.Memory;
  readonly process: () => void;
  readonly layout: Layout;
  readonly audioInputs: readonly AudioPortDecl[];
  readonly audioOutputs: readonly AudioPortDecl[];
  readonly params: readonly ParamDecl[];
};

type SelfWithState = {
  port: { postMessage: (m: unknown) => void };
  [STATE_KEY]?: WorkletState;
};

type ProcessorOptionsBag = {
  processorOptions?: { wasm?: Uint8Array };
};

const readState = (self: unknown): WorkletState => {
  const s = (self as SelfWithState)[STATE_KEY];
  if (!s) {
    throw new Error(
      "unworklet: `process(self, ...)` called before `initialize(self, opts)` — " +
        "AudioWorkletProcessor subclasses must call `def.worklet.initialize(this, opts)` in their constructor",
    );
  }
  return s;
};

export function makeWorkletNamespace(graph: CapturedGraph): WorkletNamespace {
  const lay = layout(graph);

  const audioInputs = graph.declarations.filter((d): d is AudioPortDecl => d.kind === "audioInput");
  const audioOutputs = graph.declarations.filter(
    (d): d is AudioPortDecl => d.kind === "audioOutput",
  );
  const params = graph.declarations.filter((d): d is ParamDecl => d.kind === "param");

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

    (self as SelfWithState)[STATE_KEY] = {
      memory,
      process: procFn,
      layout: lay,
      audioInputs,
      audioOutputs,
      params,
    };

    self.port.postMessage({ kind: "ready" });
  };

  const process: WorkletNamespace["process"] = (...args): boolean => {
    const self = args[0] as SelfWithState;
    const inputs = args[1] as Float32Array[][];
    const outputs = args[2] as Float32Array[][];
    const parameters = args[3] as Record<string, Float32Array>;

    const state = readState(self);
    const memory = state.memory;
    const lay = state.layout;

    // 04-worklet-runtime.md §3 / Q75 — block-length runtime guard.
    const firstOut = outputs[0]?.[0];
    if (firstOut && firstOut.length !== SAMPLES_PER_BLOCK) {
      for (const port of outputs) {
        for (const channel of port) {
          channel.fill(0);
        }
      }
      self.port.postMessage({
        kind: "error",
        code: "block-length-mismatch",
        expected: SAMPLES_PER_BLOCK,
        received: firstOut.length,
      });
      return true;
    }

    // Marshal inputs into linear memory ioScratch.inputs[port][channel].
    for (let portIdx = 0; portIdx < state.audioInputs.length; portIdx++) {
      const decl = state.audioInputs[portIdx]!;
      const portInput = inputs[portIdx] ?? [];
      const portBase = lay.regions.ioScratch.inputs[decl.name]!;
      for (let c = 0; c < decl.channels; c++) {
        const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
        const view = new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK);
        const src = portInput[c];
        if (src && src.length === SAMPLES_PER_BLOCK) {
          view.set(src);
        } else {
          view.fill(0);
        }
      }
    }

    // Marshal parameters into linear memory ioScratch.params[name].
    // AudioWorklet hands us length 0 (= no automation, use declared default),
    // 1 (= k-rate or unchanged a-rate, broadcast), or SAMPLES_PER_BLOCK
    // (= per-sample a-rate). 08-deployment.md §2 A3 unifies them at this seam.
    for (const decl of state.params) {
      const paramBase = lay.regions.ioScratch.params[decl.name]!;
      const view = new Float32Array(memory.buffer, paramBase, SAMPLES_PER_BLOCK);
      const data = parameters[decl.name];
      if (!data || data.length === 0) {
        view.fill(decl.default);
      } else if (data.length === 1) {
        view.fill(data[0]!);
      } else {
        view.set(data);
      }
    }

    state.process();

    // Marshal outputs from linear memory ioScratch.outputs[port][channel].
    for (let portIdx = 0; portIdx < state.audioOutputs.length; portIdx++) {
      const decl = state.audioOutputs[portIdx]!;
      const portOutput = outputs[portIdx] ?? [];
      const portBase = lay.regions.ioScratch.outputs[decl.name]!;
      for (let c = 0; c < decl.channels; c++) {
        const channelBase = portBase + c * CHANNEL_STRIDE_BYTES;
        const view = new Float32Array(memory.buffer, channelBase, SAMPLES_PER_BLOCK);
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
