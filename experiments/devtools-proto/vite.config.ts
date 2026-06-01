import { DevTools } from "@vitejs/devtools";
import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";

// The `@vitejs/devtools` panel plugin runs a long-lived server that keeps the
// Vite process alive after a `vp test` run ("close timed out … something prevents
// Vite server from exiting"). The panel is irrelevant to tests, so it loads only
// outside the test runner. The unworklet plugin — which lowers `.uwk.ts` and
// compiles processors — stays in every mode.
const inTest = process.env.VITEST !== undefined;

export default defineConfig({
  plugins: [...(inTest ? [] : [DevTools({ builtinDevTools: false })]), unworklet()],
  test: {
    // Default `vp test` runs the node-side offline tests only. The browser-mode
    // e2e (`*.browser.test.ts`) needs a real AudioWorklet, so it runs separately
    // via `vp test --config vite.browser.config.ts`.
    exclude: ["**/*.browser.test.ts", "**/node_modules/**", "**/dist/**"],
  },
});
