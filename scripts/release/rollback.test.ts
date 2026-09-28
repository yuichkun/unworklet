import { expect, test } from "vite-plus/test";

import { rollbackCommands } from "./rollback.ts";

test("withdrawing a release moves latest back on npm and GitHub, deprecates the bad version, then rolls the demo back", () => {
  expect(
    rollbackCommands({
      packages: ["@unworklet/core", "@unworklet/lang"],
      restore: "0.3.0",
      withdraw: "0.4.0",
      reason: "The reverb example clips.",
    }),
  ).toEqual([
    ["vp", "pm", "dist-tag", "add", "@unworklet/core@0.3.0", "latest"],
    ["vp", "pm", "dist-tag", "add", "@unworklet/lang@0.3.0", "latest"],
    [
      "vp",
      "pm",
      "deprecate",
      "@unworklet/core@0.4.0",
      "Withdrawn; use 0.3.0 until a fixed release. The reverb example clips.",
    ],
    [
      "vp",
      "pm",
      "deprecate",
      "@unworklet/lang@0.4.0",
      "Withdrawn; use 0.3.0 until a fixed release. The reverb example clips.",
    ],
    ["gh", "release", "edit", "v0.3.0", "--latest", "--repo", "yuichkun/unworklet"],
    [
      "gh",
      "workflow",
      "run",
      "rollback.yml",
      "--repo",
      "yuichkun/unworklet",
      "-f",
      "version=0.3.0",
    ],
  ]);
});
