/**
 * The renders the release compares between versions to report which examples
 * sound different. The comparison is sample-exact, so it only means something if
 * a render is reproducible and every example actually makes sound in its
 * scenario.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { examples } from "./examples.ts";
import { renderExamples } from "./render-examples.ts";

const SECOND = 48_000;

test("every example renders one second of audio, identically on every run", async () => {
  const first = mkdtempSync(path.join(tmpdir(), "uwk-render-a-"));
  const second = mkdtempSync(path.join(tmpdir(), "uwk-render-b-"));

  const index = await renderExamples(first);
  await renderExamples(second);

  expect(index.map((e) => e.slug)).toEqual(examples.map((e) => e.slug));
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
