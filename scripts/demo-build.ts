import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plugin } from "vite-plus";

const packages = ["core", "unplugin", "offline", "test", "lang"];

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function digest(root: string, files: string[], deleted = new Set<string>()) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    if (deleted.has(file)) {
      hash.update(`${file}\0deleted\0`);
      continue;
    }
    const bytes = readFileSync(join(root, file));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}

function sourceDigest(root: string) {
  return digest(
    root,
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .split("\0")
      .filter(Boolean),
    new Set(git(root, ["ls-files", "-z", "--deleted"]).split("\0")),
  );
}

function artifactDigest(root: string) {
  const files = packages.flatMap((name) => {
    const dir = `packages/${name}/dist`;
    const entries = readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)));
    if (!entries.length) throw new Error(`No built artifacts for ${name}`);
    return entries;
  });
  return digest(root, files);
}

export function prepareDemoBuild(
  root: string,
  build = (name: string) => {
    execFileSync("vp", ["run", "--filter", `@unworklet/${name}`, "build"], {
      cwd: root,
      stdio: "inherit",
    });
  },
  env: Record<string, string | undefined> = process.env,
) {
  const revision = git(root, ["rev-parse", "HEAD"]);
  if (env.VERCEL_GIT_COMMIT_SHA && env.VERCEL_GIT_COMMIT_SHA !== revision) {
    throw new Error("Deployment revision does not match the checked-out source");
  }
  const versions = packages.map(
    (name) =>
      (
        JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")) as {
          version: string;
        }
      ).version,
  );
  const version = versions[0];
  if (!/^\d+\.\d+\.\d+$/.test(version) || versions.some((value) => value !== version)) {
    throw new Error("Workspace package versions are invalid or inconsistent");
  }
  const source = sourceDigest(root);
  const dirty = git(root, ["status", "--porcelain"]).length > 0;
  // lang/browser embeds core/worklet from dist, so rebuilding core first is essential.
  for (const name of packages) build(name);
  const artifacts = artifactDigest(root);
  const prefix = env.VERCEL_ENV === "preview" ? "Preview workspace" : "Workspace";
  const info = {
    version,
    revision,
    source,
    artifacts,
    dirty,
    label: `${prefix} v${version} · ${revision.slice(0, 8)}${dirty ? " dirty" : ""} · build ${artifacts.slice(0, 8)}`,
  };
  const verify = () => {
    if (sourceDigest(root) !== source || git(root, ["rev-parse", "HEAD"]) !== revision)
      throw new Error("Demo build source changed during the build");
    if (artifactDigest(root) !== artifacts)
      throw new Error("Demo build artifacts changed during the build");
  };
  verify();
  return { info, verify };
}

export function demoBuildPlugin(
  root: string,
  prepared: ReturnType<typeof prepareDemoBuild>,
): Plugin {
  return {
    name: "demo-build-identity",
    config() {
      return { define: { __DEMO_BUILD_LABEL__: JSON.stringify(prepared.info.label) } };
    },
    async buildStart() {
      prepared.verify();
      for (const [id, file] of [
        ["@unworklet/core", "core/dist/index.mjs"],
        ["@unworklet/lang/browser", "lang/dist/browser.mjs"],
      ]) {
        const resolved = await this.resolve(id, join(root, "examples/demo/src/main.ts"));
        if (!resolved || realpathSync(resolved.id) !== realpathSync(join(root, "packages", file))) {
          throw new Error(
            `Demo package resolution does not match built workspace artifacts: ${id}`,
          );
        }
      }
    },
    generateBundle() {
      prepared.verify();
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: `${JSON.stringify(prepared.info, null, 2)}\n`,
      });
    },
  };
}
