import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    entry: ["src/index.ts"],
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
    // Each lowering builds a fresh in-memory ts.Program; a single test can lower a
    // dozen sources, and the snapshot capture/replay case does it many times over.
    // Under parallel coverage instrumentation that heaviest case runs ~30s, so the
    // per-test budget is generous.
    testTimeout: 60000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/golden/**"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        branches: 98,
      },
    },
  },
});
