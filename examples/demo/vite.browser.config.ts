/**
 * Browser e2e config for the demo. Launches headless chromium + webkit with a
 * real `AudioContext` / `WebAssembly` / `SharedArrayBuffer` and runs
 * `src/*.browser.test.ts`, which exercise `@unworklet/lang/browser`'s
 * `compileSource` (the in-browser runtime-compile path).
 *
 * Run: `vp test --config vite.browser.config.ts`.
 *
 * COOP/COEP enable cross-origin isolation so `SharedArrayBuffer` is available.
 */
import unworklet from "@unworklet/vite-plugin";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [unworklet()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    name: "demo-runtime-compile-browser",
    include: ["src/**/*.browser.test.ts"],
    // The first compile pays a one-time cold start (instantiating binaryen.js);
    // give it room, later compiles reuse the warm module.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    browser: {
      enabled: true,
      provider: playwright(),
      // webkit = Safari's engine: the worklet module registers WITHOUT a module
      // import (Safari can't resolve imports in addModule()'d code).
      instances: [{ browser: "chromium" }, { browser: "webkit" }],
      headless: true,
    },
  },
});
