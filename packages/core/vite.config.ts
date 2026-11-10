import { defineConfig } from "vite-plus";

import { writeWorkletRuntime } from "./build/worklet-runtime.ts";

export default defineConfig({
  pack: {
    dts: true,
    entry: [
      "src/index.ts",
      "src/worklet-entry.ts",
      "src/simd.ts",
      "src/dev.ts",
      "src/compile-worker.ts",
    ],
    exports: false,
    // `dist/worklet-runtime.mjs` (the `./worklet-runtime` export) is not a bundle
    // entry: it is the runtime as a string, written after every build.
    onSuccess: (config) => writeWorkletRuntime(config.cwd),
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
    // Browser-mode e2e runs under a separate config (`vite.browser.config.ts`).
    // The default `vp test` covers only node-side unit / integration tests, so it
    // excludes every browser-fixture path (those require a real `AudioContext` /
    // `SharedArrayBuffer` / `Atomics` and would fail in a node environment).
    exclude: ["src/**/*.browser.test.ts", "src/__tests__/browser/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude types-only files + public re-export hubs + test files
      // (per the `AGENTS.md` Testing policy).
      exclude: [
        "src/**/*.test.ts",
        // types-only (= no functions / branches)
        "src/types.ts",
        // public re-export hub (`export` statements only)
        "src/index.ts",
        // browser e2e fixtures require a real `AudioContext`, so they are not part
        // of node-side tests; they run under real chromium via vite.browser*.config.ts
        // and are therefore outside node coverage.
        "src/__tests__/browser/fixtures/**",
        // black-box behavior test harness (= test infrastructure, exercised by
        // every behavior test; same exclusion rationale as `*.test.ts`).
        "src/__tests__/behavior/render.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        branches: 98,
      },
    },
  },
});
