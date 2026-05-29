/**
 * `@unworklet/core` browser e2e config (= sub-phase 7.x e2e 体 制)。
 *
 * playwright 経 由 で chromium を 起 動、 real `AudioContext` /
 * `AudioWorkletNode` / `WebAssembly` / `SharedArrayBuffer` / `Atomics` /
 * `requestAnimationFrame` が 揃 う 環 境 で `src/__tests__/browser/` の e2e
 * fixture を 走 ら す。 起 動: `vp test --config vite.browser.config.ts`。
 *
 * SAB / Atomics は cross-origin isolation (= COOP/COEP) が 必 要 = vite の
 * `server.headers` で `Cross-Origin-Opener-Policy: same-origin` + `Cross-
 * Origin-Embedder-Policy: require-corp` を 設 定 す る path。
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
