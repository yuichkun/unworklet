/**
 * `@unworklet/lang` — the `.uwk.ts` authoring frontend. Lowers a `.uwk.ts`
 * source string to a virtual `.ts` module that imports from `@unworklet/core`,
 * for the Vite plugin to feed into the existing compile pipeline.
 */

export { lower, LowerError } from "./lower.ts";
export type { LowerOptions } from "./lower.ts";
export { captureFsSnapshot } from "./capture.ts";
export type { FsSnapshot } from "./program.ts";

// IDE / editor tooling (RFC-001 "Volar.js / TS LSP integration"): the language
// plugin + virtual-code generator that make `.uwk.ts` sugar type-check in an
// editor or a headless Volar program proxy.
export { generateVirtualCode } from "./ide/virtualCode.ts";
export type { GenerateOptions, VirtualCodeResult } from "./ide/virtualCode.ts";
export { createUwkLanguagePlugin, isUwkScript, UWK_LANGUAGE_ID } from "./ide/languagePlugin.ts";
export type { UwkLanguagePluginOptions } from "./ide/languagePlugin.ts";
