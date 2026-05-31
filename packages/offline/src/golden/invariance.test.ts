/**
 * Issue #10 rename invariance oracle (Phase A).
 *
 * Each golden case is compiled and fingerprinted (graph IR + layout + schemaHash
 * + wasm sha + render PCM/snapshot sha). The fingerprints in `./fixtures/` are
 * frozen at the pre-rename HEAD and MUST NOT be regenerated during the rename:
 * a red test means the authoring rename leaked into the compiled IR. Fix the
 * rename, never the fixture.
 *
 * Regenerate the fixtures ONCE, before any renaming, with:
 *   GOLDEN_UPDATE=1 vp test run src/golden/invariance.test.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { CASES } from "./cases.ts";
import { fingerprint, type GoldenFingerprint } from "./fingerprint.ts";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const UPDATE = process.env["GOLDEN_UPDATE"] === "1";

for (const testCase of CASES) {
  test(`rename invariance: ${testCase.name}`, async () => {
    const actual = await fingerprint(testCase);
    const fixturePath = `${FIXTURES_DIR}${testCase.name}.json`;
    if (UPDATE) {
      mkdirSync(FIXTURES_DIR, { recursive: true });
      writeFileSync(fixturePath, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    if (!existsSync(fixturePath)) {
      throw new Error(
        `golden fixture missing for "${testCase.name}" — generate once with GOLDEN_UPDATE=1`,
      );
    }
    const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as GoldenFingerprint;
    expect(actual).toEqual(expected);
  });
}
