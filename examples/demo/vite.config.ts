import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";

import { uwkTypeSnapshot } from "./uwk-snapshot-plugin.ts";

export default defineConfig({
  plugins: [unworklet(), uwkTypeSnapshot()],
  fmt: {},
  test: {
    // Browser e2e (`*.browser.test.ts`) runs only under `vite.browser.config.ts`
    // (real AudioContext / AudioWorklet). The default node-side `vp test` skips it.
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts", "**/node_modules/**"],
  },
});
