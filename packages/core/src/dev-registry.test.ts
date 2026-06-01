/**
 * Dev-only live-node registry (DevTools integration §4.1). The page-script reads
 * it via `@unworklet/core/dev`; here we cover register / get / unregister and
 * the change-notification used to push topology updates.
 */

import { expect, test } from "vite-plus/test";

import {
  type DevNodeHandle,
  getDevNodes,
  onDevNodesChanged,
  registerDevNode,
  unregisterDevNode,
} from "./devRegistry.ts";

const fakeHandle = (name: string): DevNodeHandle => ({
  node: {} as never,
  processorName: name,
  displayName: name,
  schemaHash: `hash-${name}`,
  devDump: async () => [],
});

test("register adds a handle, unregister removes it", () => {
  const h = fakeHandle("a");
  expect(getDevNodes()).not.toContain(h);
  registerDevNode(h);
  expect(getDevNodes()).toContain(h);
  unregisterDevNode(h);
  expect(getDevNodes()).not.toContain(h);
});

test("unregister of an unknown handle is a no-op", () => {
  const before = getDevNodes().length;
  unregisterDevNode(fakeHandle("never-registered"));
  expect(getDevNodes().length).toBe(before);
});

test("onDevNodesChanged fires on register + unregister, stops after unsubscribe", () => {
  let count = 0;
  const off = onDevNodesChanged(() => {
    count++;
  });
  const h = fakeHandle("b");
  registerDevNode(h); // +1
  unregisterDevNode(h); // +1
  off();
  const c = fakeHandle("c");
  registerDevNode(c); // no fire (unsubscribed)
  unregisterDevNode(c); // cleanup
  expect(count).toBe(2);
});
