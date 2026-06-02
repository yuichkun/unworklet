// Compile a `.uwk.ts` source string to a playable processor entirely in the
// browser — no bundler, no `?worklet` build step. This is what powers the
// live-editor: the same pipeline the Vite plugin runs at build time, replayed at
// runtime so an edited source becomes a new processor on the fly.
//
//   text → lower() (sugar → core) → transpile → eval → CompiledProcessor
//        → compile() (binaryen → WASM) → Blob URLs for the WASM + worklet entry
//        → a processor whose `.worklet` namespace carries those URLs
//
// `createNode` / `replaceProcessor` accept that namespace directly (the plugin
// only adds the same four URL fields to the raw `defineProcessor` result).
import * as core from "@unworklet/core";
import { compile, extractWorkletMeta } from "@unworklet/core";
import type { CompiledProcessor } from "@unworklet/core";
import { lower } from "@unworklet/lang";
import ts from "typescript";
// The type-environment snapshot, captured in Node by the vite plugin and shipped
// to the browser, lets `lower()` run off-disk here.
import uwkTypeSnapshot from "virtual:uwk-type-snapshot";

import workletRuntimeUrl from "./worklet-runtime.ts?worker&url";

const CORE_KEYS = Object.keys(core);

// The lower→transpile→eval path the lang golden harness uses, in the browser:
// strip the lowered module's `@unworklet/core` import + default export and run
// it with the real core exports injected as parameters.
function evalLowered(loweredTs: string): CompiledProcessor<unknown> {
  const js = ts.transpileModule(loweredTs, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const body = js
    .replace(/import\s*\{[^}]*\}\s*from\s*["']@unworklet\/core["'];?/g, "")
    .replace(/export\s+default\s+/, "return ");
  // The injected identifiers ARE the real core exports — equivalent to importing
  // them; this is the lang golden harness's `evalLowered`, run in the browser.
  // oxlint-disable-next-line typescript/no-implied-eval
  const fn = new Function(...CORE_KEYS, body) as (...args: unknown[]) => CompiledProcessor<unknown>;
  return fn(...CORE_KEYS.map((k) => (core as Record<string, unknown>)[k]));
}

// JS object-literal serialization (bigint → `0n`), matching the plugin's worklet
// template so an i64 state's `initial` survives as a native BigInt.
function serializeMeta(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : serializeMeta(v))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined && typeof v !== "function")
      .map(([k, v]) => `${JSON.stringify(k)}:${serializeMeta(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

let counter = 0;

export async function compileSource(uwkSource: string): Promise<CompiledProcessor<unknown>> {
  const processor = evalLowered(lower(uwkSource, { snapshot: uwkTypeSnapshot }));
  const { wasm } = await compile(processor);
  const meta = extractWorkletMeta(
    (processor as unknown as { graph: Parameters<typeof extractWorkletMeta>[0] }).graph,
  );
  const processorName = `uwk-runtime-${counter++}`;

  const runtimeAbsUrl = new URL(workletRuntimeUrl, import.meta.url).href;
  const entrySource = `import { makeWorkletNamespaceFromMeta } from ${JSON.stringify(runtimeAbsUrl)};
const __meta = ${serializeMeta(meta)};
const __ns = makeWorkletNamespaceFromMeta(__meta);
class UnworkletRuntimeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return __ns.parameterDescriptors; }
  constructor(o) { super(); __ns.initialize(this, o); }
  process(i, o, p) { return __ns.process(this, i, o, p); }
}
registerProcessor(${JSON.stringify(processorName)}, UnworkletRuntimeProcessor);
`;
  const moduleUrl = URL.createObjectURL(new Blob([entrySource], { type: "text/javascript" }));
  const wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: "application/wasm" }));

  return {
    ...(processor as object),
    worklet: {
      ...(processor as unknown as { worklet: object }).worklet,
      moduleUrl,
      wasmUrl,
      processorName,
      displayName: processorName,
    },
  } as CompiledProcessor<unknown>;
}
