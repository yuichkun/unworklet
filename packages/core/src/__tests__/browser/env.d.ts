/**
 * Ambient module declaration for `?worklet` imports in browser e2e fixture
 * This is the TypeScript type surface of the virtual module resolved by
 * `@unworklet/unplugin`.
 */

declare module "*?worklet" {
  import type { CompiledProcessor } from "../../index.ts";
  const processor: CompiledProcessor<unknown>;
  export default processor;
}
