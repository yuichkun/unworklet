/**
 * Minimal browser smoke = page が 起 動 + test runner が 動 く こ と だ け 検 証。
 * AudioContext / WASM / SAB が hit せ ず chromium page そ の も の の 動 作 担 保。
 */

import { expect, test } from "vite-plus/test";

test("browser page = basic JS expression が 動 く (= no AudioContext yet)", () => {
  expect(1 + 1).toBe(2);
});

test("browser page = AudioContext API が globalThis に 存 在 す る", () => {
  expect(typeof OfflineAudioContext).toBe("function");
  expect(typeof AudioWorkletNode).toBe("function");
});

test("browser page = SharedArrayBuffer が cross-origin-isolated 環 境 で 利 用 可", () => {
  expect(typeof SharedArrayBuffer).toBe("function");
  expect(globalThis.crossOriginIsolated).toBe(true);
});

test("browser page = WebAssembly + Atomics 利 用 可", () => {
  expect(typeof WebAssembly).toBe("object");
  expect(typeof Atomics).toBe("object");
  expect(typeof Atomics.load).toBe("function");
});
