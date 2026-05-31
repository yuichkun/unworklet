/**
 * Ambient type for `?worklet` imports — `@unworklet/vite-plugin` hands back a
 * worklet-bound `CompiledProcessor` as the module's default export.
 */

declare module "*?worklet" {
  import type { CompiledProcessor } from "@unworklet/core";

  const processor: CompiledProcessor<unknown>;
  export default processor;
}
