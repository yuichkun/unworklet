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
  CompileOptions,
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

/**
 * default sampleRate = 48000 (= 既 host 既 定 + 既 test fixture と zip)。
 * `compile(processor)` で sampleRate 省 略 す る と 48000 で emit、 別 sampleRate
 * 必 要 な consumer (= `renderOffline` で config.sampleRate を 渡 す path) は
 * 明 示 引 数 で 上 書 き。
 */
const DEFAULT_SAMPLE_RATE = 48000;

export async function compile<C>(
  processor: CompiledProcessor<C>,
  options: CompileOptions = {},
): Promise<CompileResult<C>> {
  const graph = processor.graph as unknown as CapturedGraph;
  const diagnostics = analyze(graph);
  // error severity diagnostic が 1 件 で も あ れ ば WASM emit 前 に reject
  // (= `03-compiler.md` §3 Layer 3 check の rejection 経 路、 stable ID を
  // error message に 含 め て consumer 側 で grep / FAQ 引 き 可)。
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    const summary = errors.map((d) => `[${d.id}] ${d.message}`).join("\n");
    throw new Error(`unworklet: compile failed with ${errors.length} error(s):\n${summary}`);
  }
  const memory = layout(graph);
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const wasm = await emit(graph, memory, { sampleRate });
  const hash = await schemaHash(graph);
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
  // driver の declarations 配 列 = renderOffline 等 の driver consumer が walk し て
  // writeInput / writeParam / readOutput を 呼 ぶ 対 象。 audioInput / audioOutput /
  // param の 3 kind だ け を 含 め、 state / buffer / event / message / midi
  // declaration は driver から 除 外 (= driver consumer は state slot に 書 き 込 まない
  // = state は WASM 内 で 完 結 + main thread surface は 別 経 路 で 取 得、 sub-phase
  // 7.x で fill)。 既 「else で param 扱 い」 path = state を param と 誤 認 し て
  // state slot に NaN (= `paramScratch.fill(undefined)` で 上 書 き) を 書 き 込 む root
  // cause bug が 発 生 し た た め、 明 示 white list path に refactor。
  const declarations: CompileInstanceDeclaration[] = [];
  for (const d of graph.declarations) {
    if (d.kind === "audioInput") {
      declarations.push({
        kind: "audioInput",
        name: d.name,
        channels: (d as AudioPortDecl).channels,
      });
    } else if (d.kind === "audioOutput") {
      declarations.push({
        kind: "audioOutput",
        name: d.name,
        channels: (d as AudioPortDecl).channels,
      });
    } else if (d.kind === "param") {
      declarations.push({ kind: "param", name: d.name, default: (d as ParamDecl).default });
    }
    // state / buffer / event / message / midi = driver か ら 除 外 (= 上 記 white list 以 外)
  }

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
