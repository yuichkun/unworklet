import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";

const REPO = path.resolve(import.meta.dirname, "../../..");

test("packed FsSnapshot imports type-check with ESNext and skipLibCheck false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-declarations-"));
  try {
    const modules = path.join(dir, "node_modules");
    mkdirSync(modules);
    for (const name of ["core", "lang"]) {
      execFileSync(
        path.join(REPO, "node_modules/.bin/vp"),
        ["pm", "pack", "--pack-destination", dir],
        {
          cwd: path.join(REPO, "packages", name),
          stdio: "pipe",
        },
      );
      const target = path.join(modules, "@unworklet", name);
      mkdirSync(target, { recursive: true });
      const archive = readdirSync(dir).find(
        (file) => file.startsWith(`unworklet-${name}-`) && file.endsWith(".tgz"),
      )!;
      execFileSync("tar", ["-xf", path.join(dir, archive), "--strip-components=1", "-C", target]);
    }
    for (const name of ["typescript", "@volar"]) {
      symlinkSync(path.join(REPO, "packages/lang/node_modules", name), path.join(modules, name));
    }
    symlinkSync(
      path.join(REPO, "packages/core/node_modules/binaryen"),
      path.join(modules, "binaryen"),
    );
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(
      path.join(dir, "index.ts"),
      'import type { FsSnapshot } from "@unworklet/lang"; export type Snapshot = FsSnapshot;',
    );
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        files: ["index.ts"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [process.env.UWK_TEST_TSC ?? path.join(modules, "typescript/bin/tsc"), "-p", dir],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
