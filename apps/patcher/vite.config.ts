import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    headers: {
      // SharedArrayBuffer cross-origin isolation for the AudioWorklet
      // SAB-based message/event/publish transports.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow serving workspace deps from the monorepo root.
      allow: [path.resolve(__dirname, "../../")],
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    // Monaco's split entries don't pre-bundle cleanly with worker imports.
    // binaryen ships as a 4MB asm.js blob with top-level await — give the
    // dep optimizer a modern target so it doesn't choke on TLA.
    exclude: ["monaco-editor"],
    esbuildOptions: {
      target: "esnext",
      supported: { "top-level-await": true },
    },
  },
  esbuild: {
    target: "esnext",
    supported: { "top-level-await": true },
  },
});
