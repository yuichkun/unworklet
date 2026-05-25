/**
 * Vitest matcher stub behavior (= `06-testing.md` §2). Phase 4 fills
 * the audio-domain assertions on top of `renderOffline`; Phase 3 =
 * every matcher throws `not implemented`.
 */

import type { RenderOfflineResult } from "@unworklet/offline";
import { expect, test } from "vite-plus/test";

import {
  expectAudioMatches,
  expectEventsEqual,
  expectNoNaN,
  expectPeakUnder,
  expectRmsUnder,
  expectStateMatches,
} from "./index.ts";

const emptyResult: RenderOfflineResult = {
  outputs: {},
  events: [],
  state: new Uint8Array(0),
};

test("`expectAudioMatches` stub throws", () => {
  expect(() => expectAudioMatches(emptyResult, emptyResult)).toThrow(/not implemented/);
});

test("`expectNoNaN` stub throws", () => {
  expect(() => expectNoNaN(emptyResult)).toThrow(/not implemented/);
});

test("`expectPeakUnder` stub throws", () => {
  expect(() => expectPeakUnder(emptyResult, -1)).toThrow(/not implemented/);
});

test("`expectRmsUnder` stub throws", () => {
  expect(() => expectRmsUnder(emptyResult, -20)).toThrow(/not implemented/);
});

test("`expectEventsEqual` stub throws", () => {
  expect(() => expectEventsEqual(emptyResult, [])).toThrow(/not implemented/);
});

test("`expectStateMatches` stub throws", () => {
  expect(() => expectStateMatches(emptyResult, new Uint8Array(0))).toThrow(/not implemented/);
});
