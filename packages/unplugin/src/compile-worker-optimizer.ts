import type { UserConfig } from "vite-plus";

import { selfcheckOptimizerOptions } from "./selfcheck-define.ts";

/**
 * The core entries a processor's compile worker imports besides the processor
 * module (see the compile worker virtual module in `index.ts`).
 */
export const COMPILE_WORKER_DEPS = [
  "@unworklet/core/compile-worker",
  "@unworklet/core/worklet-runtime",
] as const;

/**
 * The dev-server `optimizeDeps` the plugin contributes.
 *
 * - The self-check define reaches optimized dependencies (`selfcheckOptimizerOptions`).
 * - The compile worker's core entries are optimized with the app's first scan:
 *   the worker is started from a URL the scan cannot see, and discovering its
 *   imports only when it loads makes Vite re-optimize and reload the page.
 * - Binaryen, which the compile worker imports, evaluates with a top-level
 *   await. The esbuild optimizer (Vite 6 and 7) keeps the app's target but is
 *   told the browser supports that one feature: Vite 6's default target
 *   (chrome87, safari14, …) otherwise rejects it and the optimizer, and with it
 *   the dev server, fails. Vite 8 optimizes with Rolldown.
 */
export function devOptimizeDeps(viteVersion: string): NonNullable<UserConfig["optimizeDeps"]> {
  const optimizer = selfcheckOptimizerOptions(viteVersion);
  return {
    ...optimizer,
    ...("esbuildOptions" in optimizer
      ? {
          esbuildOptions: {
            ...optimizer.esbuildOptions,
            supported: { "top-level-await": true },
          },
        }
      : {}),
    include: [...COMPILE_WORKER_DEPS],
  };
}
