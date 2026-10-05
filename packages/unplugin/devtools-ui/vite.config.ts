import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  test: {
    name: "devtools-ui",
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
