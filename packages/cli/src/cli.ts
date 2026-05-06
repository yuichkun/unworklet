#!/usr/bin/env node
import { renderProcessorToWav } from "./render.js";
import { cmdBuild, cmdAnalyze, cmdBench } from "./commands.js";
import { promises as fs } from "node:fs";
import path from "node:path";

type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: "", positional: [], flags: {} };
  if (argv.length === 0) return out;
  out.command = argv[0]!;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        out.flags[key] = argv[i + 1]!;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function usage(): string {
  return `unworklet — DSP toolchain CLI

Usage:
  unworklet <command> <processor.ts> [options]

Commands:
  render    Render audio offline to a WAV file
  build     Compile to .wasm + .worklet.js + .meta.json + .wat
  dev       Watch a processor module and rebuild on change (hot reload)
  analyze   Static analysis report (cycles, memory, warnings)
  bench     Latency / CPU / NaN-Inf benchmark
  help      Show this help

Render options:
  --output <path>          Output WAV file path (required)
  --duration <seconds>     Duration to render (default: 2)
  --sample-rate <hz>       Sample rate (default: 48000)
  --input <path>           Input WAV file path (optional)
  --input-name <name>      Input port name (default: main)
  --output-name <name>     Output port name (default: main)
  --export <name>          Named export of the processor module
  --format <fmt>           WAV format: float32 | pcm16 | pcm24 (default: float32)
  --param <name=value>     Set a param value (repeatable)
  --message-json <path>    Path to JSON file with messages [{name, payload, at?}]
  --midi-json <path>       Path to JSON file with MIDI events
  --block-size <n>         Render block size (default: 128)

Examples:
  unworklet render ./examples/01-stereo-gain.ts --output gain.wav --duration 1 \\
    --param gain=0.5 --input source.wav

  unworklet render ./examples/06-arpeggiator.ts --output arp.wav --duration 4 \\
    --midi-json ./midi.json
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.command === "--help") {
    console.log(usage());
    return;
  }
  if (args.command === "render") {
    const processorPath = args.positional[0];
    if (!processorPath) {
      console.error("Error: missing processor module path");
      console.error(usage());
      process.exit(1);
    }
    const out = (args.flags["output"] as string) || "";
    if (!out) {
      console.error("Error: --output <path> is required");
      process.exit(1);
    }
    const params: Record<string, number> = {};
    // Multiple --param can be specified; in our simple parser only the last one
    // wins. Allow comma-separated as well.
    const paramArg = args.flags["param"];
    if (paramArg) {
      const items = String(paramArg).split(",");
      for (const item of items) {
        const [k, v] = item.split("=");
        if (k && v !== undefined) params[k.trim()] = Number(v);
      }
    }
    // Support multiple --param via a special handling: re-parse argv
    for (let i = 0; i < process.argv.length - 1; i++) {
      if (process.argv[i] === "--param") {
        const item = process.argv[i + 1]!;
        const [k, v] = item.split("=");
        if (k && v !== undefined) params[k.trim()] = Number(v);
      }
    }

    let messages;
    if (args.flags["message-json"]) {
      const buf = await fs.readFile(String(args.flags["message-json"]), "utf-8");
      messages = JSON.parse(buf);
    }
    let midiEvents;
    if (args.flags["midi-json"]) {
      const buf = await fs.readFile(String(args.flags["midi-json"]), "utf-8");
      midiEvents = JSON.parse(buf);
    }
    const { result, outputPath, backend } = await renderProcessorToWav({
      processorPath: path.resolve(processorPath),
      outputPath: path.resolve(out),
      duration: Number(args.flags["duration"] ?? 2),
      sampleRate: args.flags["sample-rate"] ? Number(args.flags["sample-rate"]) : undefined,
      blockSize: args.flags["block-size"] ? Number(args.flags["block-size"]) : undefined,
      inputWav: args.flags["input"] ? String(args.flags["input"]) : undefined,
      inputName: args.flags["input-name"] ? String(args.flags["input-name"]) : undefined,
      outputName: args.flags["output-name"] ? String(args.flags["output-name"]) : undefined,
      exportName: args.flags["export"] ? String(args.flags["export"]) : undefined,
      format: (args.flags["format"] as any) || "float32",
      backend: (args.flags["backend"] as any) === "js" ? "js" : "wasm",
      params: Object.keys(params).length ? params : undefined,
      messages,
      midiEvents,
    });
    console.log(`Wrote ${outputPath} (backend: ${backend})`);
    console.log(
      `  duration: ${result.output[Object.keys(result.output)[0]!]?.[0]?.length} samples`,
    );
    console.log(`  peak: ${result.peak.toFixed(4)}, rms: ${result.rms.toFixed(4)}`);
    if (result.events.length) console.log(`  events: ${result.events.length}`);
    if (result.midiOut.length) console.log(`  midiOut: ${result.midiOut.length}`);
    if (result.hasNaN) console.warn("  WARNING: output contained NaN");
    return;
  }

  if (args.command === "build") {
    const modulePath = args.positional[0];
    if (!modulePath) {
      console.error("Error: missing module path");
      process.exit(1);
    }
    const out = (args.flags["out-dir"] as string) || "./dist-unworklet";
    const arts = await cmdBuild({
      modulePath,
      exportName: args.flags["export"] ? String(args.flags["export"]) : undefined,
      outDir: out,
      sampleRate: args.flags["sample-rate"] ? Number(args.flags["sample-rate"]) : undefined,
      renderQuantum: args.flags["render-quantum"] ? Number(args.flags["render-quantum"]) : undefined,
    });
    console.log(`Built:`);
    console.log(`  wasm:    ${arts.wasmPath}`);
    console.log(`  worklet: ${arts.workletPath}`);
    console.log(`  meta:    ${arts.metaPath}`);
    console.log(`  text:    ${arts.textPath}`);
    return;
  }

  if (args.command === "analyze") {
    const modulePath = args.positional[0];
    if (!modulePath) {
      console.error("Error: missing module path");
      process.exit(1);
    }
    const fmt = ((args.flags["format"] as string) || "human") as "human" | "json" | "junit";
    const r = await cmdAnalyze({
      modulePath,
      exportName: args.flags["export"] ? String(args.flags["export"]) : undefined,
      format: fmt,
      sampleRate: args.flags["sample-rate"] ? Number(args.flags["sample-rate"]) : undefined,
    });
    console.log(r.formatted);
    process.exit(r.exitCode);
  }

  if (args.command === "dev") {
    const modulePath = args.positional[0];
    if (!modulePath) {
      console.error("Error: missing module path");
      process.exit(1);
    }
    const out = (args.flags["out-dir"] as string) || "./dist-unworklet";
    const port = args.flags["port"] ? Number(args.flags["port"]) : 5174;
    const { runDev } = await import("./dev.js");
    await runDev({
      modulePath: path.resolve(modulePath),
      outDir: path.resolve(out),
      exportName: args.flags["export"] ? String(args.flags["export"]) : undefined,
      sampleRate: args.flags["sample-rate"] ? Number(args.flags["sample-rate"]) : undefined,
      port,
    });
    return;
  }

  if (args.command === "bench") {
    const modulePath = args.positional[0];
    if (!modulePath) {
      console.error("Error: missing module path");
      process.exit(1);
    }
    const fmt = ((args.flags["format"] as string) || "human") as "human" | "json";
    const r = await cmdBench({
      modulePath,
      exportName: args.flags["export"] ? String(args.flags["export"]) : undefined,
      durationSec: args.flags["duration"] ? Number(args.flags["duration"]) : undefined,
      sampleRate: args.flags["sample-rate"] ? Number(args.flags["sample-rate"]) : undefined,
      blockSize: args.flags["block-size"] ? Number(args.flags["block-size"]) : undefined,
      format: fmt,
    });
    console.log(r.formatted);
    return;
  }

  console.error(`Unknown command: ${args.command}`);
  console.error(usage());
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
