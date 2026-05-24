/**
 * `replaceProcessor` stub behavior (= `05-client.md` §8, `decisions-log.md`
 * Q50). Phase 11 fills the live-coding hot-swap primitive; Phase 3 = throw.
 */

import { expect, test } from "vite-plus/test";

import { replaceProcessor } from "./replaceProcessor.ts";

test("`replaceProcessor(oldNode, newProcessor)` stub throws", () => {
  expect(() => replaceProcessor({} as never, {} as never)).toThrow(/not implemented/);
});
