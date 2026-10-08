/**
 * `@unworklet/core` browser e2e config for the postMessage fallback path only.
 *
 * The plugin sets COOP/COEP by default; `crossOriginIsolation: false` opts out so
 * no isolation headers are sent. Then `crossOriginIsolated === false`,
 * `SharedArrayBuffer` is unavailable, and the unworklet runtime falls back to the
 * postMessage transport — which is the path this config exercises.
 *
 * Run: `vp test --config vite.browser-postmessage.config.ts`.
 */

import unworklet from "@unworklet/unplugin";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

import { nativeRateWorklet } from "../../scripts/native-rate-worklet.ts";

import { renderCrossRealmOracle } from "./src/__tests__/browser/fixtures/crossrealm-oracle.ts";

export default defineConfig({
  plugins: [unworklet({ crossOriginIsolation: false }), nativeRateWorklet()],
  test: {
    provide: { nativeRateTransport: "postMessage" },
    name: "core-browser-postmessage",
    include: ["src/__tests__/browser/postmessage/**/*.test.ts"],
    browser: {
      enabled: true,
      commands: {
        renderCrossRealmOracle: (_context, name, sampleRate) =>
          renderCrossRealmOracle(name, sampleRate),
      },
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
