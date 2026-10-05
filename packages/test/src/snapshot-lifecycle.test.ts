import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vite-plus/test";

test("cached setup dependency resets snapshots in every file and test attempt", () => {
  const root = mkdtempSync(resolve(import.meta.dirname, "../.snapshot-lifecycle-"));
  try {
    writeFileSync(join(root, "setup.ts"), 'import "../src/extend.ts";');
    writeFileSync(
      join(root, "vite.config.ts"),
      `
      import { defineConfig } from "vite-plus";
      export default defineConfig({ test: {
        include: ["*.test.ts"], setupFiles: ["./setup.ts"],
        isolate: false, maxWorkers: 1, fileParallelism: false,
      } });
    `,
    );
    for (const name of ["first", "second"]) {
      writeFileSync(
        join(root, `${name}.test.ts`),
        `
        import { expect, test } from "vite-plus/test";
        test("repeated", { repeats: 1 }, async () => {
          await expect(Float32Array.of(0.25)).toMatchAudioSnapshot();
          await expect(Float32Array.of(0.75)).toMatchAudioSnapshot();
        });
        let attempt = 0;
        test("retried", { retry: 1 }, async () => {
          await expect(Float32Array.of(0.25)).toMatchAudioSnapshot();
          await expect(Float32Array.of(0.75)).toMatchAudioSnapshot();
          expect(++attempt).toBe(2);
        });
      `,
      );
    }
    execFileSync(
      resolve(import.meta.dirname, "../../..", "node_modules/.bin/vp"),
      ["test", "run", "--update"],
      {
        cwd: root,
        timeout: 60000,
        stdio: "pipe",
      },
    );
    const paths = readdirSync(join(root, "__snapshots__"));
    expect(paths).toHaveLength(8);
    expect(paths.every((path) => /__[12]\.wav$/.test(path))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
