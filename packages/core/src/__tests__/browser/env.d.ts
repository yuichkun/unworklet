/**
 * Ambient module declaration for `?worklet` imports in browser e2e fixture
 * path = `@unworklet/vite-plugin` 経 由 で resolve さ れ る virtual module の TS
 * 型 surface。
 */

declare module "*?worklet" {
  import type { CompiledProcessor } from "../../index.ts";
  const processor: CompiledProcessor<unknown>;
  export default processor;
}
