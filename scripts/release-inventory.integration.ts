import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { generateInventory, type Inventory } from "./release-inventory.ts";

const baseTag = "v0.4.1";
const baseSha = "fff85f19d2a24032a962479143ab3657fffb8e14";
const candidateTag = "v0.5.0";
const candidate = "0c4c889f4898197009cfc8879a1aedd1509246e2";
const knownMerges = [
  [107, "7f8dec1ab7f478c640f8e172a538f89e588b256a"],
  [130, candidate],
] as const;

export function verifyPublishedInventory(inventory: Inventory, gitCommits: string[]): void {
  assert.equal(inventory.baseTag, baseTag);
  assert.equal(inventory.baseSha, baseSha);
  assert.equal(inventory.candidate, candidate);
  assert.deepEqual(inventory.commits.map(({ sha }) => sha).sort(), [...gitCommits].sort());
  for (const [number, mergeSha] of knownMerges) {
    assert.equal(
      inventory.prs.find((pr) => pr.number === number)?.url,
      `https://github.com/yuichkun/unworklet/pull/${number}`,
    );
    assert.ok(inventory.commits.find(({ sha }) => sha === mergeSha)?.prs.includes(number));
  }
}

if (import.meta.main) {
  const output = process.argv[2];
  assert.ok(output, "Provide the public inventory artifact path");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", `refs/tags/${baseTag}^{commit}`), baseSha);
  assert.equal(git("rev-parse", `refs/tags/${candidateTag}^{commit}`), candidate);
  const gitCommits = git("rev-list", `${baseSha}..${candidate}`).split("\n");
  const inventory = await generateInventory(baseTag, candidate);
  verifyPublishedInventory(inventory, gitCommits);
  writeFileSync(output, JSON.stringify(inventory, null, 2) + "\n");
  console.log(`Verified ${gitCommits.length} commits against Git and known PRs #107/#130.`);
}
