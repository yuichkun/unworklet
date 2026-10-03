import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
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
  const fixture = mkdtempSync(path.join(demo, ".sound-check-update-"));
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
        () => ({ passed: true, output: "" }),
        (error: { stdout?: string; stderr?: string }) => ({
          passed: false,
          output: `${error.stdout}\n${error.stderr}`,
        }),
      );
      expect(hashes(goldens)).toEqual(before);
      expect(result.passed, result.output).toBe(true);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 150000);
