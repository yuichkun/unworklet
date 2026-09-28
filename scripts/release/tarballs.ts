/**
 * The release tarballs: packed once, then used unchanged for the candidate
 * demo, the checks and the npm publish. `integrity` is the value npm records as
 * `dist.integrity`, which is how the published bytes are compared with the ones
 * that were listened to.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Tarball = {
  name: string;
  version: string;
  file: string;
  integrity: string;
  dependsOn: string[];
};

export function readTarball(file: string): Tarball {
  const manifest = JSON.parse(
    execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }),
  ) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return {
    name: manifest.name,
    version: manifest.version,
    file,
    integrity: "sha512-" + createHash("sha512").update(readFileSync(file)).digest("base64"),
    dependsOn: [
      ...new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]),
    ].sort(),
  };
}

/** Groups the tarballs so every package comes after the packages it depends on. */
export function publishLayers(tarballs: Tarball[]): Tarball[][] {
  const names = new Set(tarballs.map((t) => t.name));
  const placed = new Set<string>();
  const layers: Tarball[][] = [];
  let remaining = tarballs;
  while (remaining.length > 0) {
    const layer = remaining
      .filter((t) => t.dependsOn.every((d) => !names.has(d) || placed.has(d)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (layer.length === 0) {
      throw new Error(
        `These packages depend on each other in a cycle: ${remaining
          .map((t) => t.name)
          .sort()
          .join(", ")}`,
      );
    }
    for (const t of layer) placed.add(t.name);
    layers.push(layer);
    remaining = remaining.filter((t) => !placed.has(t.name));
  }
  return layers;
}

/** Packs every public package into `outDir` and records each tarball in tarballs.json. */
function main(): void {
  const outDir = path.resolve(process.argv[2] ?? "release-tarballs");
  mkdirSync(outDir, { recursive: true });
  for (const dir of readdirSync("packages")) {
    const manifest = JSON.parse(readFileSync(path.join("packages", dir, "package.json"), "utf8"));
    if (manifest.private) continue;
    execFileSync("vp", ["pm", "pack", "--pack-destination", outDir], {
      cwd: path.join("packages", dir),
      stdio: "inherit",
    });
  }
  const tarballs = readdirSync(outDir)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => ({ ...readTarball(path.join(outDir, f)), file: f }));
  writeFileSync(path.join(outDir, "tarballs.json"), JSON.stringify(tarballs, null, 2) + "\n");
  for (const t of tarballs) console.log(`${t.name}@${t.version} ${t.integrity}`);
}

if (import.meta.main) main();
