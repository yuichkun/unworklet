/**
 * Browser e2e config for the demo's runtime-compile pipeline. Launches headless
 * chromium with a real `AudioContext` / `AudioWorkletNode` / `WebAssembly` /
 * `SharedArrayBuffer`, and runs `src/*.browser.test.ts`.
 *
 * Run: `vp test --config vite.browser.config.ts`.
 *
 * COOP/COEP enable cross-origin isolation so the SAB transport path is exercised
 * (createNode falls back to postMessage without it, but we test the full path).
 */
import unworklet from "@unworklet/vite-plugin";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

import { uwkTypeSnapshot } from "./uwk-snapshot-plugin.ts";

export default defineConfig({
  plugins: [unworklet(), uwkTypeSnapshot()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    name: "demo-runtime-compile-browser",
    include: ["src/**/*.browser.test.ts"],
    // The first runtime compile pays a one-time cold start in the browser:
    // instantiating binaryen.js, loading the TypeScript transpiler, building the
    // worklet-runtime chunk. Give it room; later compiles reuse the warm modules.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
