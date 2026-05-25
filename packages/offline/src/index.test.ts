/**
 * `renderOffline` stub behavior (= `13-offline-render.md` §2). Step 3.6
 * wires up the WASM driver path; Phase 3 = throw `not implemented`.
 */

import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("`renderOffline(processor, config)` stub throws", () => {
  expect(() => renderOffline({} as never, { sampleRate: 48000, duration: 1 })).toThrow(
    /not implemented/,
  );
});
