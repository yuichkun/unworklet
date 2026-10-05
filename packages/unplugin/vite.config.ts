import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    exports: false,
    deps: {
      skipNodeModulesBundle: true,
    },
    // Source uses the workspace toolchain; consumers provide the existing Vite peer.
    outputOptions: { paths: { "vite-plus": "vite" } },
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
    exclude: ["src/**/*.browser.test.ts", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        branches: 98,
      },
    },
  },
});
