// @unworklet/test — Vitest/Jest-friendly offline rendering for processors.
//
// Per docs/06-testing.md and draft_spec §9.1, every processor can be tested
// without a browser by rendering against the pure-JS interpreter (default)
// or the WASM backend (cross-validation).

export {
  renderOffline,
  type RenderOfflineConfig,
  type RenderOfflineResult,
  inspect,
  createNode,
} from "@unworklet/client";

import {
  compileToWasm,
  type CompileResult,
} from "@unworklet/compiler";
import type { CompiledProcessor, MidiEvent } from "@unworklet/core";

// renderOfflineWasm — same shape as renderOffline but executes the WASM
// backend (compiled via binaryen). For cross-validation tests where the
// pure-JS and WASM backends should produce equivalent output (within
// documented FP tolerance per docs/06 §2).
export type RenderOfflineWasmConfig = {
  sampleRate?: number;
  duration: number;
  blockSize?: number;
  params?: Record<string, number>;
  paramAutomation?: Record<string, (t: number) => number>;
  input?: Record<string, ((sampleOffset: number, channel: number) => number) | Float32Array[]>;
  messages?: Array<{ at?: number; name: string; payload: any }>;
  midiEvents?: Array<{ at?: number; event: MidiEvent }>;
};

export type RenderOfflineWasmResult = {
  output: Record<string, Float32Array[]>;
  events: Array<{ at: number; name: string; payload: any }>;
  midiOut: Array<{ at: number; event: MidiEvent }>;
  peak: number;
  rms: number;
  hasNaN: boolean;
};

export async function renderOfflineWasm(
  processor: CompiledProcessor,
  config: RenderOfflineWasmConfig,
): Promise<RenderOfflineWasmResult> {
  const sampleRate = config.sampleRate ?? 48000;
  const blockSize = config.blockSize ?? 128;
  const totalSamples = Math.ceil(config.duration * sampleRate);
  const numBlocks = Math.ceil(totalSamples / blockSize);
  const compileResult = compileToWasm(processor, { sampleRate, renderQuantum: blockSize });
  const mod = await WebAssembly.compile(compileResult.binary as any);
  const inst = await WebAssembly.instantiate(mod, {
    math: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
    },
  });
  const exports = inst.exports as any;
  exports.init();
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);

  const padded = numBlocks * blockSize;
  const outputs: Record<string, Float32Array[]> = {};
  for (const ao of compileResult.layout.audioOutputs.outputs) {
    const decl = compileResult.graph.declarations.audioOutputs.find((a) => a.id === ao.outputId)!;
    outputs[decl.name] = Array.from({ length: ao.channels }, () => new Float32Array(padded));
  }

  let peak = 0, sumSq = 0, n = 0, hasNaN = false;
  for (let b = 0; b < numBlocks; b++) {
    const blockStart = b * blockSize;
    // Marshal inputs
    for (const ai of compileResult.layout.audioInputs.inputs) {
      const decl = compileResult.graph.declarations.audioInputs.find((a) => a.id === ai.inputId)!;
      const inSrc = config.input?.[decl.name];
      for (let c = 0; c < ai.channels; c++) {
        const dst = mem.subarray(
          (ai.offset + c * ai.channelStride) >> 2,
          (ai.offset + c * ai.channelStride) >> 2 + blockSize,
        );
        if (Array.isArray(inSrc)) {
          const ch = inSrc[c];
          if (ch) for (let i = 0; i < blockSize; i++) {
            const s = blockStart + i;
            dst[i] = s < ch.length ? ch[s]! : 0;
          }
        } else if (typeof inSrc === "function") {
          for (let i = 0; i < blockSize; i++) dst[i] = inSrc(blockStart + i, c);
        } else {
          dst.fill(0);
        }
      }
    }
    // Marshal params
    for (const pl of compileResult.layout.params.layouts) {
      const decl = compileResult.graph.declarations.params.find((p) => p.id === pl.paramId)!;
      const v =
        config.paramAutomation?.[decl.name]?.(blockStart / sampleRate) ??
        config.params?.[decl.name] ??
        decl.default;
      if (pl.automationRate === "a-rate") {
        for (let i = 0; i < blockSize; i++) mem[(pl.offset >> 2) + i] = v;
      } else {
        mem[pl.offset >> 2] = v;
      }
    }
    exports.process(blockSize);
    // Read outputs
    for (const ao of compileResult.layout.audioOutputs.outputs) {
      const decl = compileResult.graph.declarations.audioOutputs.find((a) => a.id === ao.outputId)!;
      for (let c = 0; c < ao.channels; c++) {
        const src = mem.subarray(
          (ao.offset + c * ao.channelStride) >> 2,
          (ao.offset + c * ao.channelStride) >> 2 + blockSize,
        );
        outputs[decl.name]![c]!.set(src, blockStart);
        for (let i = 0; i < blockSize; i++) {
          const v = src[i]!;
          if (Number.isNaN(v)) hasNaN = true;
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sumSq += v * v;
          n++;
        }
      }
    }
  }
  // Trim padded outputs to totalSamples
  for (const k of Object.keys(outputs)) {
    outputs[k] = outputs[k]!.map((c) => c.slice(0, totalSamples));
  }
  return {
    output: outputs,
    events: [],
    midiOut: [],
    peak,
    rms: n > 0 ? Math.sqrt(sumSq / n) : 0,
    hasNaN,
  };
}
