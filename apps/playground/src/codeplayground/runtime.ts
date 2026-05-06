// Live-eval the user's TS source into a CompiledProcessor instance.
//
// Strategy: strip ESM `import` lines, replace `export const X = ...` with
// just `const X = ...`, append `return X` (or whatever the last identifier
// bound to a defineProcessor call is), then wrap the whole thing in
// `new Function(...primitives, body)`. Primitives come from the live
// imports in this module — no module resolution, no network.
//
// This intentionally accepts a small surface (the unworklet DSL only); it
// is NOT a general TS evaluator. The Vue component handles compile errors
// + runtime errors and surfaces them to the user.
import * as core from "@unworklet/core";
import * as simd from "@unworklet/core/simd";
import { compileToWasm } from "@unworklet/compiler";

export type EvalResult =
  | { ok: true; processor: any; processorName: string }
  | { ok: false; error: string };

export function evalProcessorSource(source: string): EvalResult {
  const stripped = source
    // Drop import lines
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, "")
    // Strip `export ` prefix (keeps `const X = ...`)
    .replace(/^\s*export\s+/gm, "")
    .trim();

  // Find the last `const NAME = defineProcessor(...)` to know which symbol
  // to return; fall back to `processor`.
  const matches = [...stripped.matchAll(/(?:^|\n)\s*const\s+(\w+)\s*=\s*defineProcessor\b/g)];
  const procName = matches.length
    ? matches[matches.length - 1]![1]!
    : "processor";

  const wrapped = `${stripped}\n;return ${procName};`;

  try {
    const fn = new Function(
      // arithmetic
      "add", "sub", "mul", "div", "mod", "neg", "min", "max", "abs", "clamp",
      // comparison
      "eq", "ne", "lt", "gt", "lte", "gte",
      // math
      "sin", "cos", "tan", "tanh", "exp", "log", "sqrt", "floor", "ceil", "frac",
      // branchless / convert / FTZ
      "select", "f32", "f64", "i32", "i64", "flushDenormals",
      // /precise + /table aliases (so users can paste either path)
      "sinPrecise", "cosPrecise", "tanPrecise", "tanhPrecise", "expPrecise", "logPrecise",
      "sinTable", "cosTable", "expTable", "logTable",
      // declarations
      "state", "buffer", "param", "audioInput", "audioOutput",
      "event", "message", "midiInput", "midiOutput",
      // control flow
      "forSample", "everyNSamples", "defineSubgraph",
      // SIMD
      "vec4", "splat", "addVec", "subVec", "mulVec", "divVec",
      // top-level
      "defineProcessor",
      wrapped,
    );
    const processor = fn(
      core.add, core.sub, core.mul, core.div, core.mod, core.neg, core.min, core.max, core.abs, core.clamp,
      core.eq, core.ne, core.lt, core.gt, core.lte, core.gte,
      core.sin, core.cos, core.tan, core.tanh, core.exp, core.log, core.sqrt, core.floor, core.ceil, core.frac,
      core.select, core.f32, core.f64, core.i32, core.i64, core.flushDenormals,
      core.sinPrecise, core.cosPrecise, core.tanPrecise, core.tanhPrecise, core.expPrecise, core.logPrecise,
      core.sinTable, core.cosTable, core.expTable, core.logTable,
      core.state, core.buffer, core.param, core.audioInput, core.audioOutput,
      core.event, core.message, core.midiInput, core.midiOutput,
      core.forSample, core.everyNSamples, core.defineSubgraph,
      simd.vec4, simd.splat, simd.addVec, simd.subVec, simd.mulVec, simd.divVec,
      core.defineProcessor,
    );
    if (!processor || typeof processor !== "object") {
      return { ok: false, error: `expected the source to define a processor named '${procName}' (or any other variable assigned by defineProcessor(...))` };
    }
    // Quick sanity: try to compile to make sure capture works. Throws a
    // structured Layer-2 error on bad input.
    compileToWasm(processor as any, { sampleRate: 48000 });
    return { ok: true, processor, processorName: procName };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const stack = err?.stack ? String(err.stack).split("\n").slice(0, 4).join("\n") : "";
    return { ok: false, error: stack ? `${msg}\n\n${stack}` : msg };
  }
}
