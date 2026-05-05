import {
  renderOffline,
  type RenderOfflineConfig,
  type RenderOfflineResult,
} from "@unworklet/client";
import { renderOfflineWasm } from "@unworklet/test";
import type { CompiledProcessor } from "@unworklet/core";
import { encodeWAV, decodeWAV, type WavFormat } from "./wav.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type CliRenderOptions = {
  processorPath: string;
  exportName?: string;
  outputPath: string;
  outputName?: string;
  duration: number;
  sampleRate?: number;
  blockSize?: number;
  inputWav?: string;
  inputName?: string;
  format?: WavFormat;
  params?: Record<string, number>;
  messages?: RenderOfflineConfig["messages"];
  midiEvents?: RenderOfflineConfig["midiEvents"];
  // 'wasm' = compile to WASM via binaryen and run that (default).
  // 'js'   = use the pure-JS interpreter (legacy / debug).
  backend?: "wasm" | "js";
};

export async function renderProcessorToWav(options: CliRenderOptions): Promise<{
  result: RenderOfflineResult;
  outputPath: string;
  backend: "wasm" | "js";
}> {
  // Load the processor module
  const absPath = path.resolve(options.processorPath);
  const url = pathToFileURL(absPath).href;
  const mod: any = await import(url);
  let processor: CompiledProcessor | undefined;
  if (options.exportName && mod[options.exportName]) {
    processor = mod[options.exportName];
  } else if (mod.default && mod.default.__isCompiledProcessor) {
    processor = mod.default;
  } else {
    for (const k of Object.keys(mod)) {
      if (mod[k] && mod[k].__isCompiledProcessor) {
        processor = mod[k];
        break;
      }
    }
  }
  if (!processor) {
    throw new Error(
      `Could not find a CompiledProcessor in ${options.processorPath}. ` +
        `Use --export <name> to specify the export.`,
    );
  }

  const sampleRate = options.sampleRate ?? 48000;
  const inputName = options.inputName ?? "main";
  const outputName = options.outputName ?? "main";
  const backend = options.backend ?? "wasm";

  let inputBuffers: Float32Array[] | undefined;
  if (options.inputWav) {
    const wavBuf = await fs.readFile(options.inputWav);
    const decoded = decodeWAV(new Uint8Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength));
    inputBuffers = decoded.channels;
  }

  const cfg: RenderOfflineConfig = {
    sampleRate,
    duration: options.duration,
    blockSize: options.blockSize,
    params: options.params,
    messages: options.messages,
    midiEvents: options.midiEvents,
  };
  if (inputBuffers) {
    cfg.input = { [inputName]: inputBuffers };
  }

  let result: RenderOfflineResult;
  if (backend === "wasm") {
    // renderOfflineWasm returns the same shape (output / events / midiOut /
    // peak / rms / hasNaN). Currently events / midiOut routing is not yet
    // collected from WASM output; for those, fall back to JS.
    const wasmResult = await renderOfflineWasm(processor, cfg as any);
    result = {
      output: wasmResult.output,
      events: wasmResult.events,
      midiOut: wasmResult.midiOut,
      peak: wasmResult.peak,
      rms: wasmResult.rms,
      hasNaN: wasmResult.hasNaN,
    };
  } else {
    result = await renderOffline(processor, cfg);
  }
  const outChannels = result.output[outputName];
  if (!outChannels) {
    throw new Error(
      `Output port "${outputName}" not declared by processor. Available: ${Object.keys(
        result.output,
      ).join(", ")}`,
    );
  }
  const wav = encodeWAV(outChannels, sampleRate, options.format ?? "float32");
  await fs.writeFile(options.outputPath, wav);

  return { result, outputPath: options.outputPath, backend };
}
