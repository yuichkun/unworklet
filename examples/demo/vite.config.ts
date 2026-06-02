import vue from "@vitejs/plugin-vue";
import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";
import type { Plugin } from "vite-plus";

// COOP/COEP make the page cross-origin isolated, which `SharedArrayBuffer` (the
// unworklet transport) requires. Vercel sets these via vercel.json; `vp dev` and
// `vp preview` need them here so the local server matches.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

export default defineConfig({
  base: "./",
  server: { headers: { ...crossOriginIsolation } },
  preview: { headers: { ...crossOriginIsolation } },
  // `@vitejs/plugin-vue` is typed `Plugin<VueApi>` while the others are
  // `Plugin<any>`; unioning the two structurally-huge generics when the array is
  // inferred trips TS2321 (excessive comparison depth). Routing `vue()` through
  // `unknown` keeps the element types uniform — it's a valid plugin regardless.
  plugins: [vue() as unknown as Plugin, unworklet()],
  fmt: {},
  test: {
    // Browser e2e (`*.browser.test.ts`) runs only under `vite.browser.config.ts`
    // (real AudioContext / AudioWorklet). The default node-side `vp test` skips it.
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts", "**/node_modules/**"],
  },
});
