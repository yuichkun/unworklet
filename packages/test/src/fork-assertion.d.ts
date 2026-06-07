/**
 * Dev-only — not shipped. This repo's test runner is the vite-plus-test fork, so
 * in-repo tests get `expect` through `vite-plus/test`, and TS keys augmentation
 * by specifier. The shipped `declare module "vitest"` in `extend.ts` therefore
 * does not reach the fork's `Assertion`, so bridge the same chain matchers onto
 * `vite-plus/test`'s `Assertion` for in-repo type-checking.
 *
 * No package entry imports this file (`pack.entry` is `index.ts` + `extend.ts`,
 * `files` is `dist` only), so `vp pack` never emits it — a stock-vitest consumer
 * only ever sees the `vitest` augmentation.
 */

import type { UnworkletAudioMatchers } from "./extend.ts";

declare module "vite-plus/test" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match the fork's own `Assertion<T = any>` signature so the declarations merge.
  interface Assertion<T = any> extends UnworkletAudioMatchers<T> {}
}
