/**
 * `createNode` / `inspect` stub behavior (= `05-client.md` §1 + §2.6).
 * Phase 6 fills `createNode`; `inspect` is a snapshot-blob free function
 * (Q48) that lands with the snapshot stack. Phase 3 = both throw stubs.
 */

import { expect, test } from "vite-plus/test";

import { createNode, inspect } from "./client.ts";

test("`createNode(ctx, processor, opts)` stub throws", () => {
  expect(() => createNode({} as never, {} as never, {} as never)).toThrow(/not implemented/);
});

test("`inspect(blob)` stub throws", () => {
  expect(() => inspect(new Uint8Array(0))).toThrow(/not implemented/);
});
