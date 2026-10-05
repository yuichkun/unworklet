import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "unplugin-hmr-browser",
    include: ["src/**/*.browser.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
