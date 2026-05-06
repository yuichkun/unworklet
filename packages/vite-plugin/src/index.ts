// @unworklet/vite-plugin — registers `?unworklet` import query so the user
// can do:
//
//   import workletURL from "./my-processor.ts?unworklet";
//   await ctx.audioWorklet.addModule(workletURL);
//
// At build / dev time the plugin loads the source module, captures the
// CompiledProcessor it exports, lowers it via @unworklet/compiler to a real
// WASM binary, and returns a generated AudioWorklet JS module that boots the
// WASM and registers `uw:<exportName>` against the AudioContext.
//
// This is the bundler integration referenced in docs/12-canonical-examples §12.18
// and docs/08-deployment §1 — without it, end-users would have to wire
// compileToWasm + generateWorkletModule + Blob URLs by hand on every site.

import {
  compileToWasm,
  generateWorkletModule,
  type CompiledProcessor,
} from "@unworklet/compiler";

export type UnworkletViteOptions = {
  // Sample rate to assume during compilation (the worklet is sample-rate
  // agnostic in IR but needs an SR for ctx.sampleRate constants). Default
  // 48000.
  sampleRate?: number;
  // Pattern for the import query suffix that triggers compilation.
  // Default `?unworklet`.
  query?: string;
};

const SUFFIX_DEFAULT = "?unworklet";

export default function unworkletPlugin(opts: UnworkletViteOptions = {}) {
  const suffix = opts.query ?? SUFFIX_DEFAULT;
  const sr = opts.sampleRate ?? 48000;
  return {
    name: "unworklet",
    enforce: "pre" as const,
    async resolveId(id: string, importer?: string) {
      if (!id.endsWith(suffix)) return null;
      // Strip the suffix and resolve the underlying module so Vite can find
      // the .ts file. Then re-attach the suffix so `load` sees this id.
      const base = id.slice(0, -suffix.length);
      // Use Vite's resolver via this.resolve when available.
      const resolved = await (this as any).resolve?.(base, importer, {
        skipSelf: true,
      });
      if (resolved) return resolved.id + suffix;
      return null;
    },
    async load(id: string) {
      if (!id.endsWith(suffix)) return null;
      const file = id.slice(0, -suffix.length);
      // Dynamic import — Vite/esbuild handles the TS transform. The user's
      // module must export the CompiledProcessor as either default or as a
      // named export matching the file basename (last segment without ext).
      const mod = await import(/* @vite-ignore */ file);
      const procName = pickExportName(file);
      const proc: CompiledProcessor =
        mod.default ?? mod[procName] ?? Object.values(mod).find(isProcessor);
      if (!isProcessor(proc)) {
        throw new Error(
          `[unworklet] ${file}: no CompiledProcessor export found. Add \`export default <processor>\` or rename the export to match the filename.`,
        );
      }
      const result = compileToWasm(proc, { sampleRate: sr });
      const source = generateWorkletModule(
        result.graph,
        result.layout,
        result.binary,
        { processorName: procName },
      );
      // Emit the worklet JS as a file asset; the import resolves to its URL.
      const ref = (this as any).emitFile?.({
        type: "asset",
        name: `unworklet-${procName}.js`,
        source,
      });
      const url = ref ? `import.meta.ROLLUP_FILE_URL_${ref}` : null;
      // Fallback for dev mode (no emitFile): return a Blob-URL builder that
      // runs in the browser at module evaluation time.
      if (!url) {
        const b64 = Buffer.from(source).toString("base64");
        return [
          `const _src = atob(${JSON.stringify(b64)});`,
          `const _blob = new Blob([_src], { type: "application/javascript" });`,
          `export default URL.createObjectURL(_blob);`,
          `export const processorName = ${JSON.stringify(`uw:${procName}`)};`,
        ].join("\n");
      }
      return [
        `export default ${url};`,
        `export const processorName = ${JSON.stringify(`uw:${procName}`)};`,
      ].join("\n");
    },
  };
}

function pickExportName(file: string): string {
  const last = file.split(/[\\/]/).pop() ?? "processor";
  return last.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]+/g, "_");
}

function isProcessor(v: any): v is CompiledProcessor {
  return !!v && typeof v === "object" && v.__isCompiledProcessor === true;
}
