import { DevTools } from "@vitejs/devtools";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { prepareDemoBuild, demoBuildPlugin } from "../../scripts/demo-build.ts";
import { createRunnableDevEnvironment, defineConfig, resolveConfig } from "vite-plus";
import type { Plugin } from "vite-plus";

// COOP/COEP make the page cross-origin isolated, which the SharedArrayBuffer
// transport uses. They're applied to `vp preview` (production-like) and to Vercel
// via vercel.json — but deliberately NOT to `vp dev`: COEP `require-corp` blocks
// the Vite DevTools iframe at `/__unworklet/`. Without them, `vp dev` falls back to
// the postMessage transport (fully functional), so audio still plays and the
// DevTools panel loads.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

export default defineConfig(async ({ command }) => {
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const prepared = command === "build" ? prepareDemoBuild(root) : undefined;
  // Defer resolution as well as loading until the clean-checkout build finishes.
  const pluginUrl = new URL("../../packages/unplugin/dist/index.mjs", import.meta.url);
  const sourceEnvironment = prepared
    ? undefined
    : createRunnableDevEnvironment(
        "ssr",
        await resolveConfig(
          {
            configFile: false,
            root: fileURLToPath(new URL("./", import.meta.url)),
            ssr: { noExternal: [/^@unworklet\//] },
            environments: { ssr: { dev: { moduleRunnerTransform: true } } },
          },
          "serve",
        ),
        { hot: false },
      );
  await sourceEnvironment?.init();
  const { default: unworklet } = sourceEnvironment
    ? await sourceEnvironment.runner.import<typeof import("@unworklet/unplugin")>(
        "@unworklet/unplugin",
      )
    : ((await import(pluginUrl.href)) as typeof import("@unworklet/unplugin"));
  return {
    define: {
      __DEMO_BUILD_LABEL__: JSON.stringify("Development · version unavailable"),
    },
    base: "./",
    preview: { headers: { ...crossOriginIsolation } },
    plugins: [
      // `@vitejs/plugin-vue` is typed `Plugin<VueApi>` while the others are
      // `Plugin<any>`; unioning the two structurally-huge generics when the array is
      // inferred trips TS2321 (excessive comparison depth). Routing `vue()` through
      // `unknown` keeps the element types uniform — it's a valid plugin regardless.
      vue() as unknown as Plugin,
      unworklet(),
      ...(sourceEnvironment
        ? [
            {
              name: "demo-source-plugin-loader",
              closeBundle: () => sourceEnvironment.close(),
            },
          ]
        : []),
      ...(prepared ? [demoBuildPlugin(root, prepared)] : []),
      // `@vitejs/devtools` hosts the Vite DevTools overlay the unworklet panel docks
      // into — without it the panel never appears. Dev-only (`vp dev`): it's pointless
      // in a production build, and its long-lived server keeps `vp test` from exiting.
      ...(command === "serve" && !process.env.VITEST
        ? [DevTools({ builtinDevTools: false }) as unknown as Plugin]
        : []),
    ],
    fmt: {},
    test: {
      // Browser e2e (`*.browser.test.ts`) runs only under `vite.browser.config.ts`
      // (real AudioContext / AudioWorklet). The default node-side `vp test` skips it.
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.browser.test.ts", "**/node_modules/**"],
    },
  };
});
