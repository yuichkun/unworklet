import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

const REPO = path.resolve(import.meta.dirname, "../../..");
const NODE = process.env.UWK_TEST_NODE ?? process.execPath;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "uwk packed runtime #"));
  const modules = path.join(dir, "node_modules");
  mkdirSync(modules);
  for (const name of ["core", "lang", "offline"]) {
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
  for (const name of ["typescript", "@volar", "binaryen", "wavefile"]) {
    const base =
      name === "binaryen"
        ? "packages/core"
        : name === "wavefile"
          ? "packages/offline"
          : "packages/lang";
    symlinkSync(path.join(REPO, base, "node_modules", name), path.join(modules, name));
  }
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function run(args: string[]) {
  const result = spawnSync(NODE, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}
test("packed CLI starts and prints the installed TypeScript version", () => {
  const version = JSON.parse(
    readFileSync(path.join(dir, "node_modules/typescript/package.json"), "utf8"),
  ).version;
  expect(run(["node_modules/@unworklet/lang/dist/unworklet-tsc.mjs", "--version"]).trim()).toBe(
    `Version ${version}`,
  );
});
test("packed helper-free sugar renders every sample at 0.5", () => {
  writeFileSync(
    path.join(dir, "render.mjs"),
    `
import assert from 'node:assert/strict';
import { lowerToProcessor } from '@unworklet/lang';
import { renderOffline } from '@unworklet/offline';
const processor = lowerToProcessor('const out = audioOutput({ channels: 1, name: "main" }); process(() => { forSample(i => { out.ch(0)[i] = f32(0.25) * 2; }); });');
const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
assert.deepEqual(Array.from(result.outputs.main[0]), Array(128).fill(0.5));
`,
  );
  run(["render.mjs"]);
});
