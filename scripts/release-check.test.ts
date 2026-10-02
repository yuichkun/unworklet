import { expect, test } from "vite-plus/test";

import { checkRelease, tagsFromLsRemote } from "./release-check.ts";

const VERSIONS_040 = {
  "@unworklet/core": "0.4.0",
  "@unworklet/lang": "0.4.0",
  "@unworklet/offline": "0.4.0",
  "@unworklet/test": "0.4.0",
  "@unworklet/unplugin": "0.4.0",
};

const release = (overrides: Partial<Parameters<typeof checkRelease>[0]> = {}) =>
  checkRelease({
    branch: "release/v0.4.0",
    sha: "merge-sha",
    sameFilesAsListened: true,
    packageVersions: VERSIONS_040,
    tags: { "v0.2.0": "sha-020", "v0.3.0": "sha-030" },
    ...overrides,
  });

test("a merged release that matches what was listened to is published at its version", () => {
  expect(release()).toEqual({ version: "0.4.0" });
});

test("a rerun of a release already tagged on its own commit continues", () => {
  expect(release({ tags: { "v0.3.0": "sha-030", "v0.4.0": "merge-sha" } })).toEqual({
    version: "0.4.0",
  });
});

test("a commit with other files than the one listened to is refused", () => {
  expect(release({ sameFilesAsListened: false })).toEqual({
    error:
      "main differs from the pull request's last commit, so this is not what was listened to. See RELEASE.md.",
  });
});

test("only release/vX.Y.Z with numbers is accepted", () => {
  for (const branch of ["release/v1.0.0-beta.1", "release/v0.4", "release/vnext"]) {
    expect(release({ branch }), branch).toEqual({
      error: `${branch} is not release/vX.Y.Z with numbers only.`,
    });
  }
});

test("every package must carry the branch's version", () => {
  expect(release({ packageVersions: { ...VERSIONS_040, "@unworklet/lang": "0.3.0" } })).toEqual({
    error: "@unworklet/lang is at 0.3.0, but release/v0.4.0 releases 0.4.0.",
  });
});

test("a version already tagged on another commit is refused", () => {
  expect(release({ tags: { "v0.3.0": "sha-030", "v0.4.0": "other-sha" } })).toEqual({
    error: "v0.4.0 was already released from other-sha.",
  });
});

test("a version lower than the highest tag is refused, because that release includes it", () => {
  expect(
    release({
      branch: "release/v0.4.1",
      packageVersions: Object.fromEntries(Object.keys(VERSIONS_040).map((name) => [name, "0.4.1"])),
      tags: { "v0.4.0": "sha-040", "v0.5.0": "sha-050", "v0.4.2": "sha-042" },
    }),
  ).toEqual({
    error:
      "v0.5.0 is already released and includes this release's changes, so v0.4.1 is not published.",
  });
});

test("versions are compared as numbers", () => {
  const at = (version: string) =>
    Object.fromEntries(Object.keys(VERSIONS_040).map((name) => [name, version]));

  expect(
    release({ branch: "release/v0.10.0", packageVersions: at("0.10.0"), tags: { "v0.9.0": "a" } }),
  ).toEqual({ version: "0.10.0" });
  expect(
    release({ branch: "release/v0.9.0", packageVersions: at("0.9.0"), tags: { "v0.10.0": "a" } }),
  ).toEqual({
    error:
      "v0.10.0 is already released and includes this release's changes, so v0.9.0 is not published.",
  });
});

test("tags that are not numbered versions are ignored", () => {
  expect(
    release({ tags: { "v0.3.0": "sha-030", "v0.5.0-beta.1": "beta", vnext: "next" } }),
  ).toEqual({ version: "0.4.0" });
});

test("tags are read from git ls-remote, with annotated tags resolved to their commits", () => {
  expect(
    tagsFromLsRemote(
      [
        "89fa9e3\trefs/tags/v0.1.0",
        "3b8d0da\trefs/tags/v0.1.0^{}",
        "f334f5a\trefs/tags/v0.2.0",
        "2414e9b\trefs/tags/v0.3.0",
      ].join("\n"),
    ),
  ).toEqual({ "v0.1.0": "3b8d0da", "v0.2.0": "f334f5a", "v0.3.0": "2414e9b" });
  expect(tagsFromLsRemote("")).toEqual({});
});
