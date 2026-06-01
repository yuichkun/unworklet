/**
 * devtools-proto browser e2e config. Boots headless chromium (playwright) with a
 * real `AudioContext` / `AudioWorkletNode` / `WebAssembly`, so `*.browser.test.ts`
 * can drive `createNode(...)` through the actual `audioWorklet.addModule(...)`
 * path — the path that crashed with "Do not know how to serialize a BigInt" on a
 * processor carrying an `i64` state. Launch: `vp test --config vite.browser.config.ts`.
 */
import unworklet from "@unworklet/vite-plugin";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [unworklet()],
  server: {
    // crossOriginIsolated → the SAB transport the live rack actually uses.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    name: "devtools-proto-browser",
    include: ["src/processors/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
