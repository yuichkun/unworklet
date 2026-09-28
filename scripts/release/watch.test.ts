import { expect, test } from "vite-plus/test";

import { checkReleaseConsistency, readReleaseState } from "./watch.ts";

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

function fakeWorld(options: { demo?: Response; github?: Response } = {}) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url === "https://unworklet.vercel.app/release.json") {
      return options.demo ?? Response.json(DEMO);
    }
    if (url === "https://api.github.com/repos/yuichkun/unworklet/releases/latest") {
      return options.github ?? Response.json({ tag_name: "v0.4.0" });
    }
    const npm = NPM[url.replace("https://registry.npmjs.org/", "") as keyof typeof NPM];
    return npm
      ? Response.json({
          "dist-tags": { latest: npm.latest },
          versions: { [npm.latest]: { dist: { integrity: npm.integrity } } },
        })
      : new Response("Not Found", { status: 404 });
  };
  return { fetch, requests };
}

test("the state is read from the production demo, npm and GitHub, asking GitHub with the workflow's token", async () => {
  const world = fakeWorld();

  expect(
    await readReleaseState({ names: Object.keys(NPM), fetch: world.fetch, githubToken: "t0ken" }),
  ).toEqual({ demo: DEMO, npm: NPM, releaseTag: "v0.4.0" });
  const github = world.requests.find((r) => r.url.startsWith("https://api.github.com/"));
  expect(github?.headers.get("authorization")).toBe("Bearer t0ken");
});

test("a production demo that answers 404 for /release.json has no manifest", async () => {
  const world = fakeWorld({ demo: new Response("Not Found", { status: 404 }) });

  const state = await readReleaseState({ names: Object.keys(NPM), fetch: world.fetch });

  expect(state.demo).toBeNull();
});

test("a request that fails is an error, not a disagreement", async () => {
  // Unauthenticated calls to GitHub's API from shared runners are often rate limited.
  const limited = fakeWorld({ github: new Response("rate limited", { status: 403 }) });
  await expect(readReleaseState({ names: Object.keys(NPM), fetch: limited.fetch })).rejects.toThrow(
    "Could not read https://api.github.com/repos/yuichkun/unworklet/releases/latest: HTTP 403.",
  );

  const down = fakeWorld({ demo: new Response("Bad Gateway", { status: 502 }) });
  await expect(readReleaseState({ names: Object.keys(NPM), fetch: down.fetch })).rejects.toThrow(
    "Could not read https://unworklet.vercel.app/release.json: HTTP 502.",
  );
});
