/**
 * `@unworklet/core` browser e2e config for the postMessage fallback path only.
 *
 * No COOP/COEP headers are set, so `crossOriginIsolated === false`,
 * `SharedArrayBuffer` is unavailable, and the unworklet runtime falls back
 * to postMessage transport. This config exercises that fallback path.
 *
 * Run: `vp test --config vite.browser-postmessage.config.ts`.
 */

import unworklet from "@unworklet/vite-plugin";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [unworklet()],
  test: {
    name: "core-browser-postmessage",
    include: ["src/__tests__/browser/postmessage/**/*.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
