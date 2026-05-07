// Live-eval helper used by every <TryIt> block in the docs.
//
// `@unworklet/core` and `@unworklet/compiler` are imported lazily inside
// the function so the docs SSR build doesn't try to traverse binaryen.js
// at module-graph analysis time (it's a 4MB asm.js blob that breaks the
// commonjs resolver's regex-based literal stripper).

export type EvalResult =
  | { ok: true; processor: any; processorName: string }
  | { ok: false; error: string };

export async function evalProcessorSource(source: string): Promise<EvalResult> {
  const core: any = await import("@unworklet/core");
  const simd: any = await import("@unworklet/core/simd");
  const { compileToWasm } = await import("@unworklet/compiler");
  const stripped = source
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, "")
    .replace(/^\s*export\s+/gm, "")
    .trim();
  const matches = [...stripped.matchAll(/(?:^|\n)\s*const\s+(\w+)\s*=\s*defineProcessor\b/g)];
  const procName = matches.length ? matches[matches.length - 1]![1]! : "processor";
  const wrapped = `${stripped}\n;return ${procName};`;
  try {
    const fn = new Function(
      "add", "sub", "mul", "div", "mod", "neg", "min", "max", "abs", "clamp",
      "eq", "ne", "lt", "gt", "lte", "gte",
      "sin", "cos", "tan", "tanh", "exp", "log", "sqrt", "floor", "ceil", "frac",
      "select", "f32", "f64", "i32", "i64", "flushDenormals",
      "sinPrecise", "cosPrecise", "tanPrecise", "tanhPrecise", "expPrecise", "logPrecise",
      "sinTable", "cosTable", "expTable", "logTable",
      "state", "buffer", "param", "audioInput", "audioOutput",
      "event", "message", "midiInput", "midiOutput",
      "forSample", "everyNSamples", "defineSubgraph",
      "vec4", "splat", "addVec", "subVec", "mulVec", "divVec",
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
      return { ok: false, error: `expected the source to define a processor (e.g. const myProc = defineProcessor(...))` };
    }
    compileToWasm(processor as any, { sampleRate: 48000 });
    return { ok: true, processor, processorName: procName };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const stack = err?.stack ? String(err.stack).split("\n").slice(0, 4).join("\n") : "";
    return { ok: false, error: stack ? `${msg}\n\n${stack}` : msg };
  }
}
