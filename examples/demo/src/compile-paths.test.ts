/**
 * The demo plays each example compiled in the browser, and can also play it
 * compiled at build time by the Vite plugin, the way most applications load a
 * processor. Listening to one path is enough only while both produce the same
 * WASM, so a build must yield byte-identical modules for every example.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite-plus";
import { expect, test } from "vite-plus/test";

import { compareCompilePaths } from "./compile-paths.ts";
import { exampleList } from "./example-list.ts";

const DEMO = fileURLToPath(new URL("..", import.meta.url));

test("every example compiles at build time to the same WASM as the in-browser path", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "uwk-demo-build-"));
  await build({ root: DEMO, logLevel: "silent", build: { outDir, emptyOutDir: true } });

  const rows = await compareCompilePaths(outDir);

  expect(rows).toEqual(exampleList.map((e) => ({ slug: e.slug, status: "identical" })));
}, 300_000);
