import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: false,
    // Convolution / FIR examples render via the JS interp engine which now
    // pays a wrap-per-chain-step cost; offline-render tests on those
    // examples need a wider window than the default 5s. Real-time WASM is
    // unaffected.
    testTimeout: 30000,
    include: [
      "tests/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "examples/tests/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
    ],
  },
});
