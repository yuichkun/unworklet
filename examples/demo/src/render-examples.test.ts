/**
 * The renders the release compares between versions to report which examples
 * sound different. The comparison is sample-exact, so it only means something if
 * a render is reproducible and every example actually makes sound in its
 * scenario.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { exampleList } from "./example-list.ts";
import { renderExamples } from "./render-examples.ts";

const SECOND = 48_000;

test("every example renders one second of audio, identically on every run", async () => {
  const first = mkdtempSync(path.join(tmpdir(), "uwk-render-a-"));
  const second = mkdtempSync(path.join(tmpdir(), "uwk-render-b-"));

  const index = await renderExamples(first);
  await renderExamples(second);

  expect(index.map((e) => e.slug)).toEqual(exampleList.map((e) => e.slug));
  expect(JSON.parse(readFileSync(path.join(first, "index.json"), "utf8"))).toEqual(index);
  for (const entry of index) {
    expect(entry.error, entry.slug).toBeUndefined();
    const files = Object.values(entry.outputs ?? {}).flat();
    expect(files.length, entry.slug).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(path.join(first, file));
      expect(bytes.length, file).toBe(SECOND * Float32Array.BYTES_PER_ELEMENT);
      expect(bytes.equals(readFileSync(path.join(second, file))), file).toBe(true);
    }
  }
}, 180_000);

test("every example makes sound in its scenario", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-render-"));

  const index = await renderExamples(dir);

  for (const entry of index) {
    const peak = Math.max(
      ...Object.values(entry.outputs ?? {})
        .flat()
        .map((file) => {
          const bytes = readFileSync(path.join(dir, file));
          const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
          return samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
        }),
    );
    expect(peak, entry.slug).toBeGreaterThan(0.01);
  }
}, 180_000);

test("a version without the functions the renderer calls is recorded example by example", () => {
  // The release renders the candidate's examples with the published version
  // too, which may predate a function the candidate renamed.
  const dir = mkdtempSync(path.join(tmpdir(), "uwk-render-old-"));
  const src = path.join(dir, "src");
  for (const file of ["render-examples.ts", "example-list.ts", "sound-scenarios.ts", "examples"]) {
    cpSync(path.join(import.meta.dirname, file), path.join(src, file), { recursive: true });
  }
  const stub = (name: string, entry: string) => {
    const root = path.join(dir, "node_modules", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name, type: "module", exports: { [entry]: "./index.js" } }),
    );
    writeFileSync(path.join(root, "index.js"), "export const unrelated = 1;\n");
  };
  stub("@unworklet/lang", "./browser");
  stub("@unworklet/offline", ".");

  execFileSync(process.execPath, [path.join(src, "render-examples.ts"), path.join(dir, "out")]);

  const index = JSON.parse(readFileSync(path.join(dir, "out", "index.json"), "utf8"));
  expect(index.map((e: { slug: string }) => e.slug)).toEqual(exampleList.map((e) => e.slug));
  for (const entry of index) expect(entry.error, entry.slug).toMatch(/lowerToProcessor/);
});
