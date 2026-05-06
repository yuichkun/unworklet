// CLI subcommand implementations: build, analyze, bench.
//
// These are the spec-mandated unworklet CLI commands per docs/07-tooling.md
// §1 and draft_spec §10.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import {
  compileToWasm,
  analyze,
  formatDiagnostic,
  type CompileResult,
  type AnalysisResult,
  type Diagnostic,
} from "@unworklet/compiler";
import type { CompiledProcessor } from "@unworklet/core";

async function loadProcessor(modulePath: string, exportName?: string): Promise<{
  processor: CompiledProcessor;
  name: string;
}> {
  const abs = path.resolve(modulePath);
  const url = pathToFileURL(abs).href;
  const mod: any = await import(url);
  let processor: CompiledProcessor | undefined;
  let name = exportName ?? "default";
  if (exportName && mod[exportName]) {
    processor = mod[exportName];
    name = exportName;
  } else if (mod.default && mod.default.__isCompiledProcessor) {
    processor = mod.default;
    name = "default";
  } else {
    for (const k of Object.keys(mod)) {
      if (mod[k] && mod[k].__isCompiledProcessor) {
        processor = mod[k];
        name = k;
        break;
      }
    }
  }
  if (!processor) throw new Error(`No CompiledProcessor in ${modulePath} (try --export <name>)`);
  return { processor, name };
}

export type BuildOptions = {
  modulePath: string;
  exportName?: string;
  outDir: string;
  sampleRate?: number;
  renderQuantum?: number;
};

export type BuildArtifacts = {
  wasmPath: string;
  workletPath: string;
  metaPath: string;
  textPath: string;
  sourceMapPath: string;
};

export async function cmdBuild(opts: BuildOptions): Promise<BuildArtifacts> {
  const { processor, name } = await loadProcessor(opts.modulePath, opts.exportName);
  const result = compileToWasm(processor, {
    sampleRate: opts.sampleRate ?? 48000,
    renderQuantum: opts.renderQuantum ?? 128,
  });
  await fs.mkdir(opts.outDir, { recursive: true });
  const wasmPath = path.join(opts.outDir, `${name}.wasm`);
  await fs.writeFile(wasmPath, result.binary);
  const textPath = path.join(opts.outDir, `${name}.wat`);
  await fs.writeFile(textPath, result.text);
  // Generate worklet bundle
  const { generateWorkletModule } = await import("@unworklet/compiler");
  const workletJs = generateWorkletModule(result.graph, result.layout, result.binary, {
    processorName: name,
  });
  const workletPath = path.join(opts.outDir, `${name}.worklet.js`);
  await fs.writeFile(workletPath, workletJs);
  // Metadata
  const meta = {
    name,
    sampleRate: opts.sampleRate ?? 48000,
    renderQuantum: opts.renderQuantum ?? 128,
    schemaHash: result.graph.schemaHash,
    declarations: {
      audioInputs: result.graph.declarations.audioInputs.map((a) => ({
        name: a.name, channels: a.channels,
      })),
      audioOutputs: result.graph.declarations.audioOutputs.map((a) => ({
        name: a.name, channels: a.channels,
      })),
      params: result.graph.declarations.params.map((p) => ({
        name: p.name, default: p.default, min: p.min, max: p.max, automationRate: p.automationRate,
      })),
      events: result.graph.declarations.events.map((e) => ({
        name: e.name, capacity: e.capacity, fields: e.fields,
      })),
      messages: result.graph.declarations.messages.map((m) => ({
        name: m.name, capacity: m.capacity, fields: m.fields,
      })),
      midiInputs: result.graph.declarations.midiInputs.map((m) => ({
        name: m.name, capacity: m.capacity,
      })),
      midiOutputs: result.graph.declarations.midiOutputs.map((m) => ({
        name: m.name, capacity: m.capacity,
      })),
    },
    memoryBytes: result.layout.totalBytes,
    memoryPages: result.layout.initialPages,
  };
  const metaPath = path.join(opts.outDir, `${name}.meta.json`);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  // Source-location sidecar (per docs/03-compiler §7 / spec ID A10).
  // Captured during graph build; maps statement paths to user-source
  // (file:line:col). Loaded by error formatters and dev tooling.
  const sourceMapPath = path.join(opts.outDir, `${name}.locations.json`);
  await fs.writeFile(sourceMapPath, JSON.stringify(result.sourceLocations ?? { files: [], entries: [] }, null, 2));
  return { wasmPath, workletPath, metaPath, textPath, sourceMapPath };
}

export type AnalyzeOptions = {
  modulePath: string;
  exportName?: string;
  format?: "human" | "json" | "junit";
  sampleRate?: number;
};

export async function cmdAnalyze(opts: AnalyzeOptions): Promise<{
  result: AnalysisResult;
  exitCode: number;
  formatted: string;
}> {
  const { processor, name } = await loadProcessor(opts.modulePath, opts.exportName);
  const compiled = compileToWasm(processor, { sampleRate: opts.sampleRate ?? 48000 });
  const result = analyze(compiled.graph, compiled.layout);
  const errCount = result.diagnostics.filter((d) => d.level === "error").length;
  const exitCode = errCount > 0 ? 1 : 0;
  const fmt = opts.format ?? "human";
  let formatted: string;
  if (fmt === "json") {
    formatted = JSON.stringify({ name, diagnostics: result.diagnostics, metrics: result.metrics }, null, 2);
  } else if (fmt === "junit") {
    const cases = result.diagnostics
      .map((d) =>
        `    <testcase classname="${name}" name="${d.code}">\n` +
        (d.level === "error" ? `      <failure message="${escapeXml(d.message)}"/>\n` : "") +
        `    </testcase>`,
      )
      .join("\n");
    formatted = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="${name}" tests="${result.diagnostics.length}" failures="${errCount}">
${cases}
  </testsuite>
</testsuites>`;
  } else {
    const lines = [`Analysis of ${name}:`];
    lines.push(`  metrics:`);
    for (const [k, v] of Object.entries(result.metrics)) {
      lines.push(`    ${k}: ${v}`);
    }
    lines.push(`  diagnostics:`);
    if (result.diagnostics.length === 0) lines.push(`    (none)`);
    else for (const d of result.diagnostics) lines.push(`    ${formatDiagnostic(d).replace(/\n/g, "\n    ")}`);
    formatted = lines.join("\n");
  }
  return { result, exitCode, formatted };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

export type BenchOptions = {
  modulePath: string;
  exportName?: string;
  durationSec?: number;
  sampleRate?: number;
  blockSize?: number;
  format?: "human" | "json";
};

export async function cmdBench(opts: BenchOptions): Promise<{
  formatted: string;
  measurements: {
    blocks: number;
    perBlockNs: { min: number; p50: number; p95: number; p99: number; max: number; mean: number };
    cpuPercent: number;
    sampleRate: number;
    blockSize: number;
    hasNaN: boolean;
    hasInf: boolean;
  };
}> {
  const { processor, name } = await loadProcessor(opts.modulePath, opts.exportName);
  const sampleRate = opts.sampleRate ?? 48000;
  const blockSize = opts.blockSize ?? 128;
  const dur = opts.durationSec ?? 2;
  const totalBlocks = Math.ceil((dur * sampleRate) / blockSize);

  const result = compileToWasm(processor, { sampleRate, renderQuantum: blockSize });
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(result.binary as any), {
    math: {
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, pow: Math.pow, atan2: Math.atan2,
    },
  });
  const exports = inst.exports as any;
  exports.init();
  const mem = new Float32Array((exports.memory as WebAssembly.Memory).buffer);

  // Fill input scratch with a pulse (impulse + zeros) to exercise the path.
  for (const ai of result.layout.audioInputs.inputs) {
    for (let c = 0; c < ai.channels; c++) {
      const start = (ai.offset + c * ai.channelStride) >> 2;
      mem[start] = 1.0; // impulse
    }
  }

  // Pre-warm
  for (let i = 0; i < 64; i++) exports.process(blockSize);

  const samples: number[] = new Array(totalBlocks);
  let hasNaN = false;
  let hasInf = false;
  for (let b = 0; b < totalBlocks; b++) {
    const t0 = performance.now();
    exports.process(blockSize);
    const t1 = performance.now();
    samples[b] = (t1 - t0) * 1e6; // ns
    // Quick output check
    for (const ao of result.layout.audioOutputs.outputs) {
      const start = (ao.offset) >> 2;
      const v = mem[start]!;
      if (Number.isNaN(v)) hasNaN = true;
      if (!Number.isFinite(v)) hasInf = true;
    }
  }
  samples.sort((a, b) => a - b);
  const pick = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  const min = samples[0]!;
  const max = samples[samples.length - 1]!;
  const p50 = pick(0.5);
  const p95 = pick(0.95);
  const p99 = pick(0.99);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const blockNs = (blockSize / sampleRate) * 1e9;
  const cpuPercent = (mean / blockNs) * 100;

  const measurements = {
    blocks: totalBlocks,
    perBlockNs: { min, p50, p95, p99, max, mean },
    cpuPercent,
    sampleRate,
    blockSize,
    hasNaN,
    hasInf,
  };

  const fmt = opts.format ?? "human";
  let formatted: string;
  if (fmt === "json") {
    formatted = JSON.stringify({ name, measurements }, null, 2);
  } else {
    formatted =
      `Bench ${name} @ ${sampleRate} Hz, ${blockSize} samples/block, ${totalBlocks} blocks (${dur}s):\n` +
      `  per-block (ns): min=${min.toFixed(0)}  p50=${p50.toFixed(0)}  p95=${p95.toFixed(0)}  p99=${p99.toFixed(0)}  max=${max.toFixed(0)}  mean=${mean.toFixed(0)}\n` +
      `  CPU usage:      ${cpuPercent.toFixed(2)}% of audio budget\n` +
      `  output sanity:  hasNaN=${hasNaN}  hasInf=${hasInf}`;
  }
  return { formatted, measurements };
}
