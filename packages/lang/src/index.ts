/**
 * `@unworklet/lang` — the `.uwk.ts` authoring frontend. Lowers a `.uwk.ts`
 * source string to a virtual `.ts` module that imports from `@unworklet/core`,
 * for the Vite plugin to feed into the existing compile pipeline.
 */

export { lower, LowerError } from "./lower.ts";
export type { LowerOptions } from "./lower.ts";
export { captureFsSnapshot } from "./capture.ts";
export type { FsSnapshot } from "./program.ts";
