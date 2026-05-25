/**
 * `unworklet` Vite plugin factory stub behavior (= `07-vite-plugin.md`).
 * Phase 5 wires up the real Vite plugin; Phase 3 = throw `not implemented`
 * + alias invariant (= named `unworkletPlugin` re-exports the default).
 */

import { expect, test } from "vite-plus/test";

import unworklet, { unworkletPlugin } from "./index.ts";

test("`unworklet()` default plugin factory stub throws", () => {
  expect(() => unworklet()).toThrow(/not implemented/);
});

test("`unworkletPlugin` is the same reference as the default export", () => {
  expect(unworkletPlugin).toBe(unworklet);
});
