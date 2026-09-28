/**
 * The demo says what the listener is hearing. A release deployment is promoted
 * to production without a rebuild, so the same bytes serve both the candidate
 * URL and the production domain: whether it is released can only be told from
 * where it is opened.
 */
import { expect, test } from "vite-plus/test";

import { describeBuild } from "./build-info.ts";

test("the release tarballs on the production domain are the released version", () => {
  expect(
    describeBuild({ version: "0.4.0", tarballs: "a1b2c3d4", hostname: "unworklet.vercel.app" }),
  ).toEqual({
    label: "v0.4.0 · released",
    detail: "Built from the release tarballs a1b2c3d4.",
  });
});

test("the release tarballs anywhere else are a release candidate", () => {
  expect(
    describeBuild({
      version: "0.4.0",
      tarballs: "a1b2c3d4",
      hostname: "unworklet-qk88pb42c-escentier.vercel.app",
    }),
  ).toEqual({
    label: "v0.4.0 · release candidate",
    detail: "Built from the release tarballs a1b2c3d4, which are not released yet.",
  });
});

test("a build from the repository is a development build, wherever it is served", () => {
  expect(
    describeBuild({ version: "0.3.0", tarballs: undefined, hostname: "unworklet.vercel.app" }),
  ).toEqual({
    label: "development build",
    detail: "Built from the repository rather than release tarballs; based on v0.3.0.",
  });
});
