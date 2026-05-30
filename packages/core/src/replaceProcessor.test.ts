/**
 * `replaceProcessor` is the async live-coding hot-swap primitive (`05-client.md`
 * §8, `decisions-log.md` Q50): it snapshots the running node, stands up the new
 * processor via `createNode`, and restores state forward through the migration
 * chain. The end-to-end orchestration needs the `createNode` mock harness, so its
 * behavioral coverage (ReplaceResult shape, failed-migration node, the >50-swap
 * warning) lives in `client.test.ts`. This file pins the local contract: it is an
 * async function that surfaces errors via promise rejection, never a sync throw.
 */

import { expect, test } from "vite-plus/test";

import { replaceProcessor } from "./replaceProcessor.ts";

test("`replaceProcessor` is async — a malformed node rejects the returned promise (not a sync throw)", async () => {
  const result = replaceProcessor({} as never, {} as never);
  expect(result).toBeInstanceOf(Promise);
  await expect(result).rejects.toThrow();
});
