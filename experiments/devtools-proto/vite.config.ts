import { DevTools } from "@vitejs/devtools";
import unworklet from "@unworklet/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig(async () => ({
  plugins: [...(await DevTools({ builtinDevTools: false })), unworklet()],
}));
