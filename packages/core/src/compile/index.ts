/**
 * `compile(processor)` — public WASM emission entry (`03-compiler.md` §1).
 *
 * Single async named export on `@unworklet/core` that all consumers
 * (`@unworklet/vite-plugin` build pipeline, `@unworklet/offline`'s
 * `renderOffline`, `replaceProcessor`, and pure Node / browser host
 * scripts that build processors at runtime) call.
 *
 * Orchestrates the 4 per-stage internal modules (= plan Q-D):
 *
 *   capturedGraph = processor.__capture(sampleRate)  ← re-capture at the host rate
 *                   (= ctx.sampleRate coefficient precomputation at the real rate)
 *   diagnostics   = analyze(graph)        ← Layer 3 check (memory-budget, etc.)
 *   memory        = layout(graph)         ← sub-region partitioning + ioScratch
 *   wasm          = await emit(graph,     ← binaryen lower (dynamic import)
 *                              memory)
 *   schemaHash    = schemaHash(graph)     ← declarations-only FNV-1a hex
 *
 * Returns `{ wasm, graph, memory, diagnostics, schemaHash,
 * __compiledProcessor }`. `graph` / `memory` / `diagnostics` are opaque branded
 * casts — consumers treat them as tokens (e.g. vite-plugin / inspect tooling
 * restores the internal types to emit a JSON artifact).
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

import { analyze, checkMemoryBudget } from "./analyze.ts";
import type { AudioPortDecl, CapturedGraph, ParamDecl } from "./ast.ts";
import { emit } from "./emit.ts";
import { layout } from "./layout.ts";
import type { Layout } from "./layout.ts";
import { schemaHash } from "./schemaHash.ts";

const BYTES_PER_F32 = 4;
const CHANNEL_STRIDE_BYTES = SAMPLES_PER_BLOCK * BYTES_PER_F32;

/**
 * Default sampleRate = 48000 (= matches the host default and existing test fixtures).
 * Omitting sampleRate in `compile(processor)` emits at 48000; consumers that need a
 * different sampleRate (e.g. `renderOffline` passing `config.sampleRate`) override it
 * via the explicit argument.
 */
const DEFAULT_SAMPLE_RATE = 48000;

export async function compile<C>(
  processor: CompiledProcessor<C>,
  options: CompileOptions = {},
): Promise<CompileResult<C>> {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  // Re-capture with the host rate so `ctx.sampleRate` coefficient precomputation
  // (`440 / ctx.sampleRate`, etc.) uses the real rate — the eager `graph` is the
  // rate-independent metadata view. Falls back to `graph` for hand-built fixtures.
  const graph = (processor.__capture
    ? processor.__capture(sampleRate)
    : processor.graph) as unknown as CapturedGraph;
  const diagnostics = analyze(graph);
  // `layout` is pure sizing that packs the memory sub-regions and fixes `totalBytes`.
  // The memory-budget (Q30) can only be judged once `totalBytes` is known, so we run
  // layout → budget check before the error gate, then enter the reject decision.
  const memory = layout(graph);
  diagnostics.push(...checkMemoryBudget(memory.totalBytes));
  // If there is even one error-severity diagnostic, reject before WASM emit
  // (= the rejection path of `03-compiler.md` §3 Layer 3 check; the stable ID is
  // included in the error message so consumers can grep it / look it up in the FAQ).
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    const summary = errors.map((d) => `[${d.id}] ${d.message}`).join("\n");
    throw new Error(`unworklet: compile failed with ${errors.length} error(s):\n${summary}`);
  }
  const wasm = await emit(graph, memory, { sampleRate });
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
  // The driver's `declarations` array is what driver consumers (e.g. renderOffline)
  // walk to call writeInput / writeParam / readOutput. Include only the 3 kinds
  // audioInput / audioOutput / param, and exclude state / buffer / event / message /
  // midi declarations (= driver consumers never write into a state slot — state stays
  // fully inside WASM and the main-thread surface is fetched via a separate path,
  // filled in sub-phase 7.x). A prior "treat as param in the else branch" path was the
  // root-cause bug that misidentified state as a param and wrote NaN into a state slot
  // (= overwritten by `paramScratch.fill(undefined)`), so this is refactored into an
  // explicit white-list path.
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
    // state / buffer / event / message / midi = excluded from the driver (= not on the white list above)
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
