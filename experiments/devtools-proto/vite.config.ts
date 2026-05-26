import { DevTools } from "@vitejs/devtools";
import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [DevTools({ builtinDevTools: false }), unworklet()],
});
