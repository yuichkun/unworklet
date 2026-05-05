import {
  renderOffline,
  type RenderOfflineConfig,
  type RenderOfflineResult,
} from "@unworklet/client";
import type { CompiledProcessor } from "@unworklet/core";
import { encodeWAV, decodeWAV, type WavFormat } from "./wav.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type CliRenderOptions = {
  processorPath: string; // Path to a TS/JS module that exports a CompiledProcessor (default export or named export)
  exportName?: string; // Default: default export, falling back to first export that is a CompiledProcessor
  outputPath: string; // Path to a .wav output file
  outputName?: string; // Audio output port name (default: 'main')
  duration: number; // Seconds
  sampleRate?: number;
  blockSize?: number;
  inputWav?: string; // Path to a .wav input file
  inputName?: string; // Audio input port name (default: 'main')
  format?: WavFormat;
  params?: Record<string, number>;
  messages?: RenderOfflineConfig["messages"];
  midiEvents?: RenderOfflineConfig["midiEvents"];
};

export async function renderProcessorToWav(options: CliRenderOptions): Promise<{
  result: RenderOfflineResult;
  outputPath: string;
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

  const result = await renderOffline(processor, cfg);
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

  return { result, outputPath: options.outputPath };
}
