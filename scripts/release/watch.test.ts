import { expect, test } from "vite-plus/test";

import { checkReleaseConsistency } from "./watch.ts";

const DEMO = {
  version: "0.4.0",
  fingerprint: "a1b2c3d4",
  packages: { "@unworklet/core": "sha512-core", "@unworklet/lang": "sha512-lang" },
};
const NPM = {
  "@unworklet/core": { latest: "0.4.0", integrity: "sha512-core" },
  "@unworklet/lang": { latest: "0.4.0", integrity: "sha512-lang" },
};

test("a production demo built from npm's latest tarballs, released and tagged, is consistent", () => {
  expect(checkReleaseConsistency({ demo: DEMO, npm: NPM, releaseTag: "v0.4.0" })).toEqual([]);
});

test("every way the three can disagree is reported", () => {
  expect(
    checkReleaseConsistency({
      demo: { ...DEMO, packages: { ...DEMO.packages, "@unworklet/lang": "sha512-other" } },
      npm: { ...NPM, "@unworklet/core": { latest: "0.3.0", integrity: "sha512-old" } },
      releaseTag: "v0.3.0",
    }),
  ).toEqual([
    "npm's latest versions differ between packages: @unworklet/core 0.3.0, @unworklet/lang 0.4.0.",
    "The production demo is v0.4.0, but npm's latest @unworklet/core is 0.3.0.",
    "The production demo was built from other @unworklet/lang@0.4.0 bytes than npm serves.",
    "The latest GitHub Release is v0.3.0, but npm's latest @unworklet/lang is 0.4.0.",
  ]);
});

test("a production demo without a release manifest was not deployed by the release workflow", () => {
  expect(checkReleaseConsistency({ demo: null, npm: NPM, releaseTag: "v0.4.0" })).toEqual([
    "The production demo has no /release.json, so it was not deployed by the release workflow.",
  ]);
});
