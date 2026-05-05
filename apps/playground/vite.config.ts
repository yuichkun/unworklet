import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    headers: {
      // Required for SharedArrayBuffer (cross-origin isolation).
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow serving workspace files (monorepo packages live above the
      // playground root). Required for the headless wasm-audio-test which
      // dynamically imports @unworklet/compiler + examples via /@fs/...
      allow: [path.resolve(__dirname, "../../")],
    },
  },
});
