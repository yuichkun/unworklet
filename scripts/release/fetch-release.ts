/**
 * Downloads a published release as the exact tarballs npm serves, so the
 * release's sound comparison plays the current release through the same demo
 * the candidate is heard in.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { readTarball } from "./tarballs.ts";
import type { Tarball } from "./tarballs.ts";

const REGISTRY = "https://registry.npmjs.org";

export async function fetchRelease(options: {
  names: string[];
  version: string;
  dir: string;
  fetch: (url: string) => Promise<Response>;
}): Promise<Tarball[]> {
  const version =
    options.version === "latest"
      ? (
          (await (await options.fetch(`${REGISTRY}/${options.names[0]}`)).json()) as {
            "dist-tags": { latest: string };
          }
        )["dist-tags"].latest
      : options.version;

  mkdirSync(options.dir, { recursive: true });
  const tarballs: Tarball[] = [];
  for (const name of options.names) {
    const response = await options.fetch(`${REGISTRY}/${name}/${version}`);
    if (!response.ok) {
      throw new Error(`${name}@${version} could not be read from npm (${response.status}).`);
    }
    const { dist } = (await response.json()) as { dist: { tarball: string; integrity: string } };
    const bytes = Buffer.from(await (await options.fetch(dist.tarball)).arrayBuffer());
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    if (integrity !== dist.integrity) {
      throw new Error(
        `${name}@${version} downloaded as ${integrity}, but npm records ${dist.integrity}.`,
      );
    }
    const file = `${name.slice(1).replace("/", "-")}-${version}.tgz`;
    writeFileSync(path.join(options.dir, file), bytes);
    tarballs.push({ ...readTarball(path.join(options.dir, file)), file });
  }
  writeFileSync(path.join(options.dir, "tarballs.json"), JSON.stringify(tarballs, null, 2) + "\n");
  return tarballs;
}

/**
 * `fetch-release.ts <version|latest> <candidate tarball dir> <out dir>`: downloads
 * the given release of every package the candidate ships.
 */
async function main(): Promise<void> {
  const [version, candidateDir, out] = process.argv.slice(2);
  const names = (
    JSON.parse(readFileSync(path.join(candidateDir!, "tarballs.json"), "utf8")) as Tarball[]
  ).map((t) => t.name);
  const tarballs = await fetchRelease({ names, version: version!, dir: path.resolve(out!), fetch });
  console.log(`Fetched ${tarballs.map((t) => `${t.name}@${t.version}`).join(", ")}`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `version=${tarballs[0]!.version}\n`);
}

if (import.meta.main) await main();
