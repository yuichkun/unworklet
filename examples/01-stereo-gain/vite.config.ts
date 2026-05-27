import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [unworklet()],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    include: ["src/**/*.test.ts"],
  },
});
