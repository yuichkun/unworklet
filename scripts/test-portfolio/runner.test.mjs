import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discover } from "./check.mjs";

void test(
  "installed collector follows live includes, excludes and browser instances without running setup or importing tests",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(resolve(tmpdir(), "test-portfolio-"));
    const write = (file, content) => writeFileSync(resolve(root, file), content);
    try {
      mkdirSync(resolve(root, "node_modules"));
      symlinkSync(
        dirname(fileURLToPath(import.meta.resolve("vite-plus/package.json"))),
        resolve(root, "node_modules/vite-plus"),
        "dir",
      );
      write("package.json", JSON.stringify({ type: "module", private: true }));
      write("setup.mjs", "throw new Error('global setup must not execute during file discovery');");
      for (const name of ["a", "excluded", "browser"])
        write(
          `${name}.test.ts`,
          "throw new Error('test module must not be imported during file discovery');",
        );
      write(
        "vite.node.config.ts",
        `import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { name: 'unit', include: ['*.test.ts'], exclude: ['excluded.test.ts', 'browser.test.ts'], globalSetup: ['./setup.mjs'] } });`,
      );
      write(
        "vite.browser.config.ts",
        `import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { name: 'transport', include: ['browser.test.ts'], browser: { enabled: true, instances: [{ browser: 'chromium' }, { browser: 'firefox' }] } } });`,
      );
      write(
        "vite.config.ts",
        `import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { include: [], globalSetup: ['./setup.mjs'], projects: ['./vite.node.config.ts', './vite.browser.config.ts'] } });`,
      );
      const first = await discover(root, "vite.config.ts");
      assert.deepEqual(
        first.projects.find((entry) => entry.config === "vite.node.config.ts").files,
        ["a.test.ts"],
      );
      assert.deepEqual(
        first.projects
          .filter((entry) => entry.browser)
          .map((entry) => entry.browser)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ["chromium", "firefox"],
      );
      write("new.test.ts", "throw new Error('new tests must be discovered, not executed');");
      const next = await discover(root, "vite.config.ts");
      assert.deepEqual(
        next.projects.find((entry) => entry.config === "vite.node.config.ts").files,
        ["a.test.ts", "new.test.ts"],
      );
      write(
        "vite.node.config.ts",
        `import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { name: 'unit', include: ['new.test.ts'] } });`,
      );
      const narrowed = await discover(root, "vite.config.ts");
      assert.deepEqual(
        narrowed.projects.find((entry) => entry.config === "vite.node.config.ts").files,
        ["new.test.ts"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
