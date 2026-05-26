/**
 * `unworklet` Vite plugin factory shape (= `07-vite-plugin.md` + `10-roadmap.md`
 * Phase 5)。 5-B = factory が real Vite `Plugin` object (= `{ name, ... }`) を
 * 返 す こ と を 担 保、 hook 中 身 は 5-C 以 降 で fill。
 */

import { expect, test } from "vite-plus/test";

import unworklet, { unworkletPlugin } from "./index.ts";

test("`unworklet()` returns a Vite Plugin object with a stable name", () => {
  const plugin = unworklet();
  expect(plugin).toMatchObject({ name: "@unworklet/vite-plugin" });
});

test("`unworklet()` accepts an options bag without throwing", () => {
  expect(() => unworklet({})).not.toThrow();
  expect(() => unworklet({ emitAnalysisArtifacts: false })).not.toThrow();
  expect(() =>
    unworklet({ include: ["**/*.processor.ts"], exclude: ["**/node_modules/**"] }),
  ).not.toThrow();
});

test("`unworkletPlugin` is the same reference as the default export", () => {
  expect(unworkletPlugin).toBe(unworklet);
});
