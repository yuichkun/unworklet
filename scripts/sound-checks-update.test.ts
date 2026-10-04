import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const demo = path.resolve(import.meta.dirname, "../examples/demo");
const hashes = (directory: string) =>
  Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith(".wav"))
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(directory, name)))
          .digest("hex"),
      ]),
  );

test("sound-checks:update preserves every golden when sources are unchanged", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sound-check-update-"));
  const fixture = path.join(root, "examples/demo");
  mkdirSync(fixture, { recursive: true });
  mkdirSync(path.join(root, "scripts"));
  cpSync(path.join(import.meta.dirname, "demo-build.ts"), path.join(root, "scripts/demo-build.ts"));
  symlinkSync(path.resolve(demo, "../../packages"), path.join(root, "packages"));
  try {
    for (const file of [
      "package.json",
      "vite.config.ts",
      "src/examples.ts",
      "src/sound-checks.ts",
      "src/sound-checks.render.test.ts",
      "src/__goldens__",
    ]) {
      cpSync(path.join(demo, file), path.join(fixture, file), { recursive: true });
    }
    for (const modules of [
      path.resolve(demo, "../../node_modules"),
      path.join(demo, "node_modules"),
    ]) {
      for (const entry of readdirSync(modules).filter((name) => !name.startsWith("."))) {
        const names = entry.startsWith("@")
          ? readdirSync(path.join(modules, entry)).map((name) => `${entry}/${name}`)
          : [entry];
        for (const name of names) {
          const target = path.join(fixture, "node_modules", name);
          mkdirSync(path.dirname(target), { recursive: true });
          if (!existsSync(target)) symlinkSync(path.join(modules, name), target);
        }
      }
    }
    const goldens = path.join(fixture, "src/__goldens__");
    const before = hashes(goldens);
    const env = { ...process.env };
    delete env.CI;
    for (const args of [
      ["run", "sound-checks:update"],
      ["test", "run", "-u", "src/sound-checks.render.test.ts", "-t", "pipe "],
    ]) {
      const result = await promisify(execFile)("vp", args, {
        cwd: fixture,
        env,
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
      }).then(
        ({ stdout, stderr }) => ({ passed: true, output: `${stdout}\n${stderr}` }),
        (error: { stdout?: string; stderr?: string }) => ({
          passed: false,
          output: `${error.stdout}\n${error.stderr}`,
        }),
      );
      expect(hashes(goldens)).toEqual(before);
      expect(hashes(path.join(demo, "src/__goldens__"))).toEqual(before);
      expect(result.passed, result.output).toBe(true);
      expect(result.output).toContain(fixture);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150000);
