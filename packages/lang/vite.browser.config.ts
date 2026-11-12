/**
 * Vite library build for the `@unworklet/lang/browser` entry. `vp pack` (tsdown)
 * can't bundle the two build-time assets `browser.ts` needs (the type snapshot +
 * the inlined worklet runtime), so this entry is built here by `vp build` and
 * `scripts/build.mjs` orchestrates both.
 *
 * The two assets are computed in Node at build time and injected via `define`,
 * so the published `dist/browser.mjs` is self-contained (no user-side plugin, no
 * bundler lock-in). `@unworklet/core` (every entry) + `typescript` stay external.
 */
import workletRuntime from "@unworklet/core/worklet-runtime";
import { defineConfig } from "vite-plus";

import { captureFsSnapshot } from "./src/capture.ts";

export default defineConfig({
  define: {
    // The type snapshot lets `lower()` run off-disk in the browser. JSON literal.
    __UWK_SNAPSHOT__: JSON.stringify(captureFsSnapshot()),
    // The self-contained worklet runtime IIFE that core's build ships (core is
    // built first). A JS string literal.
    __UWK_WORKLET_RUNTIME__: JSON.stringify(workletRuntime),
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/browser.ts",
      formats: ["es"],
      fileName: () => "browser.mjs",
    },
    rollupOptions: {
      external: [/^@unworklet\/core(\/|$)/, "typescript"],
    },
  },
});
