import { defineConfig } from "vite-plus";

/**
 * Test project for repo-wide release invariants — assertions that span every
 * package at once (the lockstep version guard), so they fit in no single
 * package's suite.
 *
 * This exists as its own project config because the root `vite.config.ts` is not
 * a collector once it lists `projects`: a `test.include` written there is never
 * read, and a test file outside every project silently never runs.
 */
export default defineConfig({
  test: {
    name: "release-invariants",
    include: ["*.test.ts"],
  },
});
