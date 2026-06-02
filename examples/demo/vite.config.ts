import { DevTools } from "@vitejs/devtools";
import vue from "@vitejs/plugin-vue";
import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";
import type { Plugin } from "vite-plus";

// COOP/COEP make the page cross-origin isolated, which the SharedArrayBuffer
// transport uses. They're applied to `vp preview` (production-like) and to Vercel
// via vercel.json — but deliberately NOT to `vp dev`: COEP `require-corp` blocks
// the Vite DevTools iframe at `/__unworklet/`. Without them, `vp dev` falls back to
// the postMessage transport (fully functional), so audio still plays and the
// DevTools panel loads.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

export default defineConfig(({ command }) => ({
  base: "./",
  preview: { headers: { ...crossOriginIsolation } },
  plugins: [
    // `@vitejs/plugin-vue` is typed `Plugin<VueApi>` while the others are
    // `Plugin<any>`; unioning the two structurally-huge generics when the array is
    // inferred trips TS2321 (excessive comparison depth). Routing `vue()` through
    // `unknown` keeps the element types uniform — it's a valid plugin regardless.
    vue() as unknown as Plugin,
    unworklet(),
    // `@vitejs/devtools` hosts the Vite DevTools overlay the unworklet panel docks
    // into — without it the panel never appears. Dev-only (`vp dev`): it's pointless
    // in a production build, and its long-lived server keeps `vp test` from exiting.
    ...(command === "serve" && !process.env.VITEST
      ? [DevTools({ builtinDevTools: false }) as unknown as Plugin]
      : []),
  ],
  fmt: {},
  test: {
    // Browser e2e (`*.browser.test.ts`) runs only under `vite.browser.config.ts`
    // (real AudioContext / AudioWorklet). The default node-side `vp test` skips it.
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts", "**/node_modules/**"],
  },
}));
