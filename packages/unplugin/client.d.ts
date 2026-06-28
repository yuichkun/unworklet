/**
 * Ambient types for `@unworklet/unplugin`. Pull them in with one line at the
 * top of any `.d.ts` in your project (or via tsconfig `compilerOptions.types`):
 *
 *     /// <reference types="@unworklet/unplugin/client" />
 *
 * It types the `?worklet` import the plugin intercepts. Vite's own HMR types
 * (`import.meta.hot`) live in `vite/client` — reference that too if you use HMR.
 */

declare module "*?worklet" {
  import type { CompiledProcessor } from "@unworklet/core";

  /**
   * The compiled processor the plugin produces for a `?worklet` import, ready to
   * hand to `createNode`. The per-processor type witness is erased across the
   * virtual-module boundary, so it is `unknown` here.
   */
  const processor: CompiledProcessor<unknown>;
  export default processor;
}
