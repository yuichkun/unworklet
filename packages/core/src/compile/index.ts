/**
 * `compile(processor)` — public WASM emission entry (`03-compiler.md` §1).
 *
 * Single async named export on `@unworklet/core` that all consumers
 * (`@unworklet/vite-plugin` build pipeline, `@unworklet/offline`'s
 * `renderOffline`, `replaceProcessor`, and pure Node / browser host
 * scripts that build processors at runtime) call.
 *
 * Orchestrates the 4 stage-別 internal modules (= plan Q-D):
 *
 *   capturedGraph = processor.graph (= defineProcessor で 構 築 済 の
 *                                       brand-only CapturedGraph)
 *   diagnostics   = analyze(graph)        ← Phase 3 = noop = []
 *   memory        = layout(graph)         ← sub-region 区 切 り + ioScratch
 *   wasm          = await emit(graph,     ← binaryen lower (dynamic import)
 *                              memory)
 *   schemaHash    = schemaHash(graph)     ← JSON.stringify + SHA-256 hex
 *
 * Returns `{ wasm, graph, memory, diagnostics, schemaHash,
 * __compiledProcessor }`。 graph / memory / diagnostics は opaque brand
 * cast = consumer は token と し て 扱 う (= vite-plugin / inspect 等 で
 * 内 部 type を 復 元 し て JSON artifact emit)。
 */

import { SAMPLES_PER_BLOCK } from "../dsl/constants.ts";
import type {
  CompiledProcessor,
  CompileDriver,
  CompileInstance,
  CompileInstanceDeclaration,
  CompileResult,
  DiagnosticsJson,
  GraphJson,
  MemoryJson,
} from "../types.ts";

import { analyze } from "./analyze.ts";
import type { AudioPortDecl, CapturedGraph, ParamDecl } from "./ast.ts";
import { emit } from "./emit.ts";
import { layout } from "./layout.ts";
import type { Layout } from "./layout.ts";
import { schemaHash } from "./schemaHash.ts";

const BYTES_PER_F32 = 4;
const CHANNEL_STRIDE_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

export async function compile<C>(processor: CompiledProcessor<C>): Promise<CompileResult<C>> {
  const graph = processor.graph as unknown as CapturedGraph;
  const diagnostics = analyze(graph);
  const memory = layout(graph);
  const wasm = await emit(graph, memory);
  const hash = schemaHash(graph);
  return {
    wasm,
    graph: graph as unknown as GraphJson,
    memory: memory as unknown as MemoryJson,
    diagnostics: diagnostics as unknown as DiagnosticsJson,
    schemaHash: hash,
    driver: makeDriver(graph, memory, wasm),
    __compiledProcessor: undefined as unknown as C,
  };
}

export function makeDriver(graph: CapturedGraph, lay: Layout, wasm: Uint8Array): CompileDriver {
  const declarations: CompileInstanceDeclaration[] = graph.declarations.map((d) => {
    if (d.kind === "audioInput") {
      return { kind: "audioInput", name: d.name, channels: (d as AudioPortDecl).channels };
    }
    if (d.kind === "audioOutput") {
      return { kind: "audioOutput", name: d.name, channels: (d as AudioPortDecl).channels };
    }
    return { kind: "param", name: d.name, default: (d as ParamDecl).default };
  });

  return {
    async instantiate(): Promise<CompileInstance> {
      const wasmModule = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
      const instance = await WebAssembly.instantiate(wasmModule);
      const memory = instance.exports["memory"] as WebAssembly.Memory;
      const proc = instance.exports["process"] as () => void;

      const inputBase = (portName: string, channel: number): number =>
        lay.regions.ioScratch.inputs[portName]! + channel * CHANNEL_STRIDE_BYTES;
      const outputBase = (portName: string, channel: number): number =>
        lay.regions.ioScratch.outputs[portName]! + channel * CHANNEL_STRIDE_BYTES;
      const paramBase = (paramName: string): number => lay.regions.ioScratch.params[paramName]!;

      return {
        memory,
        process: proc,
        declarations,
        writeInput(portName, channel, blockData) {
          const view = new Float32Array(
            memory.buffer,
            inputBase(portName, channel),
            SAMPLES_PER_BLOCK,
          );
          for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
            view[s] = blockData[s]!;
          }
        },
        writeParam(paramName, blockData) {
          const view = new Float32Array(memory.buffer, paramBase(paramName), SAMPLES_PER_BLOCK);
          for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
            view[s] = blockData[s]!;
          }
        },
        readOutput(portName, channel, dest) {
          const view = new Float32Array(
            memory.buffer,
            outputBase(portName, channel),
            SAMPLES_PER_BLOCK,
          );
          for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
            dest[s] = view[s]!;
          }
        },
      };
    },
  };
}
