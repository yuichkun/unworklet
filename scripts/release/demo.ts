/**
 * Builds the candidate demo: the demo as it is committed, installed outside the
 * monorepo with every @unworklet package taken from the release tarballs. The
 * deployment built here is the one that is listened to and, once approved,
 * promoted to production unchanged.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";

import type { Tarball } from "./tarballs.ts";

const DEMO = "examples/demo";

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
};

export function assembleDemo(options: {
  repo: string;
  tarballDir: string;
  tarballs: Tarball[];
  out: string;
}): void {
  const tracked = execFileSync("git", ["ls-files", "-z", DEMO], {
    cwd: options.repo,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const file of tracked) {
    const target = path.join(options.out, path.relative(DEMO, file));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(options.repo, file), target);
  }

  const fromTarball = new Map(
    options.tarballs.map((t) => [t.name, `file:${path.join(options.tarballDir, t.file)}`]),
  );
  const pin = (deps: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(deps).map(([name, spec]) => [name, fromTarball.get(name) ?? spec]),
    );

  const root = JSON.parse(
    readFileSync(path.join(options.repo, "package.json"), "utf8"),
  ) as Manifest;
  const demo = JSON.parse(
    readFileSync(path.join(options.repo, DEMO, "package.json"), "utf8"),
  ) as Manifest;
  demo.dependencies = pin(demo.dependencies);
  demo.devDependencies = {
    ...pin(demo.devDependencies),
    "vite-plus": root.devDependencies!["vite-plus"]!,
  };
  demo.packageManager = root.packageManager;
  writeFileSync(path.join(options.out, "package.json"), JSON.stringify(demo, null, 2) + "\n");

  const settings = parse(
    readFileSync(path.join(options.repo, "pnpm-workspace.yaml"), "utf8"),
  ) as Record<string, unknown>;
  delete settings.packages;
  settings.overrides = {
    ...(settings.overrides as Record<string, string> | undefined),
    ...Object.fromEntries(fromTarball),
  };
  writeFileSync(path.join(options.out, "pnpm-workspace.yaml"), stringify(settings));
}

/** Lays the built demo out in Vercel's Build Output API format, with the headers from vercel.json. */
export function writeVercelOutput(options: {
  dist: string;
  vercelJson: string;
  out: string;
}): void {
  const output = path.join(options.out, ".vercel", "output");
  cpSync(options.dist, path.join(output, "static"), { recursive: true });
  const { headers = [] } = JSON.parse(readFileSync(options.vercelJson, "utf8")) as {
    headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const routes = headers.map((h) => ({
    src: h.source,
    headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])),
    continue: true,
  }));
  writeFileSync(
    path.join(output, "config.json"),
    JSON.stringify({ version: 3, routes }, null, 2) + "\n",
  );
}

/** `demo.ts <tarball dir> <out dir>`: assembles, installs and builds the candidate demo into `<out dir>/.vercel/output`. */
function main(): void {
  const tarballDir = path.resolve(process.argv[2] ?? "release-tarballs");
  const out = path.resolve(process.argv[3] ?? "release-demo");
  const tarballs = JSON.parse(
    readFileSync(path.join(tarballDir, "tarballs.json"), "utf8"),
  ) as Tarball[];
  const demo = path.join(out, "demo");

  assembleDemo({ repo: process.cwd(), tarballDir, tarballs, out: demo });
  execFileSync("vp", ["install"], { cwd: demo, stdio: "inherit" });
  execFileSync("vp", ["build"], { cwd: demo, stdio: "inherit" });
  writeVercelOutput({ dist: path.join(demo, "dist"), vercelJson: "vercel.json", out });
  console.log(`Candidate demo built into ${path.join(out, ".vercel", "output")}`);
}

if (import.meta.main) main();
