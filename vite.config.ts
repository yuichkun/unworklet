import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: false,
    include: ["tests/**/*.test.ts", "packages/*/tests/**/*.test.ts", "examples/tests/**/*.test.ts"],
  },
});
