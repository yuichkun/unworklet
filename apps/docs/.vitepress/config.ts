import { defineConfig } from "vitepress";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  title: "unworklet",
  description: "TypeScript-first declarative DSL for declarative AudioWorklet DSP, compiled to WASM.",
  cleanUrls: true,
  vite: {
    server: {
      // SAB / Atomics need cross-origin isolation. Without these the
      // <TryIt> playback would silently fall back to postMessage transport.
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
      fs: {
        // Serve from the monorepo so workspace deps resolve when vitepress
        // pulls in @unworklet/core etc.
        allow: [path.resolve(__dirname, "../../../")],
      },
    },
    preview: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    optimizeDeps: {
      // Monaco's split entries don't pre-bundle cleanly with the worker
      // imports — exclude them so they load as native ESM in dev.
      // binaryen is a 4MB asm.js blob with top-level await — ship it
      // through the dep optimizer with a modern esbuild target.
      exclude: ["monaco-editor"],
      esbuildOptions: {
        target: "esnext",
        supported: { "top-level-await": true },
      },
    },
    ssr: {
      // Don't try to traverse binaryen during SSR — its size + TLA shape
      // crashes the commonjs resolver. The TryIt component imports the
      // compiler dynamically on the client only.
      external: ["binaryen", "@unworklet/compiler"],
    },
    esbuild: {
      target: "esnext",
      supported: { "top-level-await": true },
    },
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Recipes", link: "/recipes/one-pole-filter" },
      { text: "API", link: "/api/core" },
      { text: "Playground", link: "http://127.0.0.1:5173/#/15-playground", target: "_blank" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Why unworklet", link: "/guide/why" },
            { text: "Install + quickstart", link: "/guide/getting-started" },
            { text: "Your first processor", link: "/guide/your-first-processor" },
          ],
        },
        {
          text: "Building blocks",
          items: [
            { text: "Audio I/O + forSample", link: "/guide/audio-io" },
            { text: "State + buffers", link: "/guide/state-and-buffers" },
            { text: "Parameters", link: "/guide/parameters" },
            { text: "Messages + events", link: "/guide/messages-events" },
            { text: "MIDI", link: "/guide/midi" },
            { text: "SIMD", link: "/guide/simd" },
            { text: "Sub-rate (everyNSamples)", link: "/guide/sub-rate" },
            { text: "Subgraphs (DSP libraries)", link: "/guide/subgraphs" },
          ],
        },
        {
          text: "Realtime hygiene",
          items: [
            { text: "Denormals + flushDenormals", link: "/guide/denormals" },
            { text: "Snapshot + restore", link: "/guide/snapshots" },
            { text: "Migrations", link: "/guide/migrations" },
            { text: "Static analysis + diagnostics", link: "/guide/static-analysis" },
          ],
        },
        {
          text: "Deployment",
          items: [
            { text: "Vite plugin", link: "/guide/vite-plugin" },
            { text: "Hot reload (unworklet dev)", link: "/guide/hot-reload" },
            { text: "Bench / golden WAVs", link: "/guide/testing" },
          ],
        },
      ],
      "/recipes/": [
        {
          text: "Recipes",
          items: [
            { text: "One-pole low-pass", link: "/recipes/one-pole-filter" },
            { text: "Soft-clip distortion", link: "/recipes/soft-clip" },
            { text: "Ping-pong delay", link: "/recipes/ping-pong-delay" },
            { text: "Envelope follower", link: "/recipes/envelope-follower" },
            { text: "Stereo widener", link: "/recipes/stereo-widener" },
            { text: "MIDI to gate trigger", link: "/recipes/midi-gate" },
          ],
        },
      ],
      "/api/": [
        {
          text: "Reference",
          items: [
            { text: "@unworklet/core", link: "/api/core" },
            { text: "@unworklet/core/simd", link: "/api/simd" },
            { text: "@unworklet/dsp", link: "/api/dsp" },
            { text: "@unworklet/client", link: "/api/client" },
            { text: "@unworklet/worklet", link: "/api/worklet" },
            { text: "CLI", link: "/api/cli" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/yuichkun/unworklet" }],
    footer: {
      message: "Apache-2.0",
    },
  },
});
