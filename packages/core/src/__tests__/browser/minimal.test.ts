/**
 * Minimal browser smoke test — verifies only that the page boots and the test runner executes.
 * Does not touch AudioContext / WASM / SAB; confirms the Chromium page itself is functional.
 */

import { expect, test } from "vite-plus/test";

test("browser page = basic JS expressions evaluate correctly (no AudioContext yet)", () => {
  expect(1 + 1).toBe(2);
});

test("browser page = AudioContext API is present on globalThis", () => {
  expect(typeof OfflineAudioContext).toBe("function");
  expect(typeof AudioWorkletNode).toBe("function");
});

test("browser page = SharedArrayBuffer is available in a cross-origin-isolated context", () => {
  expect(typeof SharedArrayBuffer).toBe("function");
  expect(globalThis.crossOriginIsolated).toBe(true);
});

test("browser page = WebAssembly and Atomics are available", () => {
  expect(typeof WebAssembly).toBe("object");
  expect(typeof Atomics).toBe("object");
  expect(typeof Atomics.load).toBe("function");
});
