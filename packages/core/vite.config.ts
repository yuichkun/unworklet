import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    entry: ["src/index.ts", "src/worklet-entry.ts", "src/simd.ts"],
    exports: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    include: ["src/**/*.test.ts"],
    // Browser-mode e2e は 別 config (= `vite.browser.config.ts`) で 起 動。
    // default `vp test` は node-side unit / integration の み = browser fixture
    // path を 全 exclude (= real `AudioContext` / `SharedArrayBuffer` / `Atomics`
    // 必 須 で node 環 境 で fail する path)。
    exclude: ["src/**/*.browser.test.ts", "src/__tests__/browser/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude types-only files + public re-export hubs + test files
      // (= `AGENTS.md` Testing policy 通 り).
      exclude: [
        "src/**/*.test.ts",
        // types-only (= no functions / branches)
        "src/types.ts",
        "src/compile/ast.ts",
        // public re-export hub (= `export` 文 だ け)
        "src/index.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        branches: 98,
      },
    },
  },
});
