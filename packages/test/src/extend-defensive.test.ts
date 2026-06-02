/**
 * Defensive branch tests for the `@unworklet/test/extend` chain form.
 * Forces the `err instanceof Error` === false path inside `wrap()` and
 * `toMatchAudioSnapshotChain` (i.e. the `String(err)` fallback reached when
 * a plain function throws a non-Error value) by substituting the real
 * implementations via `vi.mock`.
 *
 * Plain functions ordinarily throw only `new Error(...)`, making these
 * defensive branches unreachable in normal execution. The mocks trigger
 * `throw "raw string"` / `throw 42` to exercise the String-conversion path.
 *
 * `vi.mock` is hoisted file-wide, so this path is isolated in its own file.
 */

import { expect, test, vi } from "vite-plus/test";

vi.mock("./index.ts", async () => {
  const actual = await vi.importActual<typeof import("./index.ts")>("./index.ts");
  return {
    ...actual,
    // Replace the plain function with a string-throwing stub so that
    // `err instanceof Error` is false inside the chain `wrap()` catch,
    // forcing the `String(err)` fallback branch.
    expectAudioMatches: () => {
      throw "raw-string-not-an-Error";
    },
    // Trigger the same non-Error throw via the chain `toMatchAudioSnapshot`
    // path to hit the `String(err)` fallback inside `toMatchAudioSnapshotChain`.
    expectAudioMatchesSnapshotWithState: async () => {
      throw 42;
    },
  };
});

// Import extend.ts after the mock is applied so that `expect.extend` closes
// over the stubbed plain functions.
await import("./extend.ts");

import type { RenderOfflineResult } from "@unworklet/offline";

const monoResult = (channel: Float32Array): RenderOfflineResult => ({
  outputs: { main: [channel] },
  events: [],
  state: new Uint8Array(0),
  sampleRate: 48000,
});

test("`wrap()` catch `String(err)` branch — fallback message when a plain function throws a string", () => {
  // The mocked `expectAudioMatches` throws "raw-string-not-an-Error" (a non-Error),
  // so `err instanceof Error` is false inside `wrap()` catch, and the
  // `String(err)` fallback path surfaces the stringified value as the failure message.
  expect(() => expect(monoResult(new Float32Array(8))).toMatchAudio([new Float32Array(8)])).toThrow(
    /raw-string-not-an-Error/,
  );
});

test("`toMatchAudioSnapshotChain` catch `String(err)` branch — fallback when a number is thrown", async () => {
  // The mocked `expectAudioMatchesSnapshotWithState` throws 42 (a non-Error),
  // so `err instanceof Error` is false inside `toMatchAudioSnapshotChain` catch,
  // and `String(err)` (= "42") is used as the fallback failure message.
  await expect(expect(monoResult(new Float32Array(8))).toMatchAudioSnapshot()).rejects.toThrow(
    /42/,
  );
});
