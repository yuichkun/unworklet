/**
 * `@unworklet/lang` — the `.uwk.ts` authoring frontend. Lowers a `.uwk.ts`
 * source string to a virtual `.ts` module that imports from `@unworklet/core`,
 * for the Vite plugin to feed into the existing compile pipeline.
 */

export { lower, LowerError } from "./lower.ts";
export type { LowerOptions } from "./lower.ts";
export { captureFsSnapshot } from "./capture.ts";
export type { FsSnapshot } from "./program.ts";

// AST helpers over a lowered module's imports, for a bundler to lower transitive
// `.uwk.ts` imports (a processor importing a subgraph from a sibling `.uwk.ts`).
export { rewriteImportSpecifiers, uwkImportSpecifiers } from "./uwk-imports.ts";

// Headless authoring: lower a `.uwk.ts` source straight to a `CompiledProcessor`
// for `@unworklet/offline`'s `renderOffline` — no Vite plugin, no browser. The
// browser entry exposes the same call backed by a build-time type snapshot.
export { lowerToProcessor } from "./eval-lowered.ts";

// IDE / editor tooling (RFC-001 "Volar.js / TS LSP integration"): the language
// plugin + virtual-code generator that make `.uwk.ts` sugar type-check in an
// editor or a headless Volar program proxy.
export { generateVirtualCode } from "./ide/virtualCode.ts";
export type { GenerateOptions, VirtualCodeResult } from "./ide/virtualCode.ts";
export { createUwkLanguagePlugin, isUwkScript, UWK_LANGUAGE_ID } from "./ide/languagePlugin.ts";
export type { UwkLanguagePluginOptions } from "./ide/languagePlugin.ts";

// Cold-checkout tsconfig seed — writes `.unworklet/tsconfig.json` (extended by
// consumer tsconfigs via `"extends": "./.unworklet/tsconfig.json"`) so a fresh
// clone can `unworklet-tsc` / `vite build` before anything else runs.
export { seedUnworkletDir, GENERATED_TSCONFIG } from "./seed-unworklet-dir.ts";

// Per-processor `?worklet` type witness generator. Emits the `declare module`
// entries that make `import x from "./x.uwk.ts?worklet"` type as
// `CompiledProcessor<{ params; state; events; midi; inputs; outputs }>` — the
// same string the unplugin writes on `vite build` AND that `unworklet-tsc`
// writes at startup on a cold checkout (R5 gap 4 root fix). Shared here so both
// paths produce byte-identical witnesses.
export { workletDts, workletsDts } from "./worklet-dts.ts";

// Multi-file `.uwk.ts` lowering — writes lowered temp siblings for a file and
// its transitive `.uwk.ts` imports so Node's native `import()` can load the
// whole graph. The Vite plugin uses this on the build path; offline / test
// callers use `loadUwkProcessor` to render a multi-file processor without a
// bundler.
export {
  deriveExportName,
  isUwkSource,
  loadUwkProcessor,
  lowerUwkSource,
  materializeLowered,
} from "./materialize-lowered.ts";
