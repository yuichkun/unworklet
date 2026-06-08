/**
 * `@unworklet/core` browser e2e config.
 *
 * Launches chromium via playwright in an environment that provides real
 * `AudioContext` / `AudioWorkletNode` / `WebAssembly` / `SharedArrayBuffer` /
 * `Atomics` / `requestAnimationFrame`, and runs the e2e fixtures under
 * `src/__tests__/browser/`. To run: `vp test --config vite.browser.config.ts`.
 *
 * SAB / Atomics require cross-origin isolation (COOP/COEP), which is enabled
 * via `server.headers` with `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`.
 */

import unworklet from "@unworklet/unplugin";
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
    name: "core-browser-sab",
    include: ["src/__tests__/browser/*.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
