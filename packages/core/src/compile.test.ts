/**
 * `compile()` stub behavior (= `03-compiler.md` §1). Step 3.5 wires up
 * binaryen emission; the Phase 3 stub throws `not implemented`.
 */

import { expect, test } from "vite-plus/test";

import { compile } from "./compile.ts";

test("`compile(processor)` stub throws", () => {
  expect(() => compile({} as never)).toThrow(/not implemented/);
});
