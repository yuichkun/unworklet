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
    // dozen sources, so a heavy case brushes the default 5s under parallel load.
    testTimeout: 30000,
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
