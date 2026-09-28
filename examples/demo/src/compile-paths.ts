// Compares, for every example, the WASM the Vite plugin emitted into a demo
// build with the WASM the in-browser path produces for the same source. The
// plugin compiles at 48 kHz, so the in-browser path is compiled at that rate
// too. Exits non-zero when any example differs or is missing from the build.
//
//   node src/compile-paths.ts <dist dir>
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { compile } from "@unworklet/core";
import { lowerToProcessor } from "@unworklet/lang/browser";

import { exampleList } from "./example-list.ts";

export type CompilePathRow = { slug: string; status: "identical" | "different" | "missing" };

export async function compareCompilePaths(dist: string): Promise<CompilePathRow[]> {
  const assets = readdirSync(path.join(dist, "assets"));
  const rows: CompilePathRow[] = [];
  for (const { slug } of exampleList) {
    const built = assets.find((file) => file.startsWith(`${slug}-`) && file.endsWith(".wasm"));
    if (!built) {
      rows.push({ slug, status: "missing" });
      continue;
    }
    const source = readFileSync(new URL(`./examples/${slug}.uwk.ts`, import.meta.url), "utf8");
    const { wasm } = await compile(lowerToProcessor(source), { sampleRate: 48_000 });
    const same = Buffer.from(wasm).equals(readFileSync(path.join(dist, "assets", built)));
    rows.push({ slug, status: same ? "identical" : "different" });
  }
  return rows;
}

if (import.meta.main) {
  const rows = await compareCompilePaths(path.resolve(process.argv[2] ?? "dist"));
  for (const row of rows) console.log(`${row.status.padEnd(9)} ${row.slug}`);
  if (rows.some((row) => row.status !== "identical")) process.exitCode = 1;
}
