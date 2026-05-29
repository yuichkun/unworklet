import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [unworklet()],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    // Default `vp test` = Node-side unit / integration test only
    // (`*.test.ts` で `*.browser.test.ts` は 除 外)。
    //
    // Browser-mode smoke test (= `src/main.browser.test.ts`) を 走 ら せ る
    // 起 動 path = `docs/10-roadmap.md` §Phase 6 完 了 条 件:
    //   1. `vp add -D @vitest/browser @vitest/browser-playwright playwright`
    //   2. `vp exec playwright install chromium`
    //   3. 別 config (= `vite.browser.config.ts`) で `test.browser.provider`
    //      に `import { playwright } from "@vitest/browser-playwright"` を
    //      設 定 し、 `vp test --config vite.browser.config.ts` で 起 動。
    //
    // headless chromium で real `AudioContext` / `AudioWorkletNode` /
    // `WebAssembly` が 揃 う = Ex 1 を 実 環 境 で 走 ら せ る smoke。
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts", "tests/**/*.spec.ts", "**/node_modules/**"],
  },
});
