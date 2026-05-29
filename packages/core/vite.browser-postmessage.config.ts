/**
 * `@unworklet/core` browser e2e config (= postMessage fallback path 専 用)。
 *
 * COOP/COEP ヘ ッ ダ を 設 定 し な い = `crossOriginIsolated === false` =
 * `SharedArrayBuffer` 不 可 = unworklet runtime が postMessage transport に
 * fallback す る 経 路 を test。
 *
 * 起 動: `vp test --config vite.browser-postmessage.config.ts`。
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
