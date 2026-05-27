/**
 * Ambient module declaration for `?worklet` imports = `@unworklet/vite-plugin`
 * 経 由 で virtual module 形 で 渡 さ れ る CompiledProcessor の TS 型 surface。
 */

declare module "*?worklet" {
  import type { CompiledProcessor } from "@unworklet/core";
  const processor: CompiledProcessor<unknown>;
  export default processor;
}
