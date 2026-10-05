import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vite-plus/test";

test("repeated Vite builds use current native ESM helpers across the source graph", () => {
  // Native import must run outside Vitest's module runner, whose own cache and
  // transforms otherwise hide Node's persistent transitive ESM cache.
  const root = mkdtempSync(path.resolve(import.meta.dirname, "../__fixtures__/reload-"));
  const runner = path.join(root, "run.mjs");
  writeFileSync(
    runner,
    `import { strict as assert } from "node:assert";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite-plus";
import { audioOutput, compile, defineProcessor, forSample } from "@unworklet/core";
import unworklet from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "index.ts")).href)};

const root = import.meta.dirname;
const app = path.join(root, "app");
await mkdir(app);
const dependency = path.join(root, "node_modules/reload-external");
await mkdir(dependency, { recursive: true });
await writeFile(path.join(dependency, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
await writeFile(path.join(dependency, "index.mjs"), "export const identity = {};\\n");
globalThis.expectedFramework = defineProcessor;
globalThis.expectedDependency = (await import("reload-external")).identity;
const entry = path.join(app, "tone.processor.mjs");
const helper = path.join(app, "constants.mjs");
const outside = path.join(root, "outside.mjs");
await writeFile(outside, "export const OFFSET = 0;\\n");
await writeFile(helper, 'import { OFFSET } from "../outside.mjs"; export const LEVEL = 0.25 + OFFSET;\\n');
await writeFile(entry, \`import { audioOutput, defineProcessor, forSample } from "@unworklet/core";
import { strict as assert } from "node:assert";
import { identity } from "reload-external";
import { LEVEL } from "./constants.mjs";
assert.equal(defineProcessor, globalThis.expectedFramework);
assert.equal(identity, globalThis.expectedDependency);
export const tone = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  return { process: () => forSample(i => out.ch(0).at(i).write(LEVEL)) };
});
\`);
await writeFile(path.join(app, "main.mjs"), 'export { default } from "./tone.processor.mjs?worklet";\\n');
const entryStat = await stat(entry);
const helperStat = await stat(helper);
const outsideStat = await stat(outside);

async function expected(level) {
  const processor = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    return { process: () => forSample(i => out.ch(0).at(i).write(level)) };
  });
  return (await compile(processor)).wasm;
}

async function buildWasm(plugin = unworklet()) {
  const result = await build({
    root: app,
    configFile: false,
    logLevel: "silent",
    plugins: [plugin],
    build: {
      write: false,
      minify: false,
      lib: { entry: path.join(app, "main.mjs"), formats: ["es"] },
      rollupOptions: { external: [helper, "@unworklet/core", "node:assert", "reload-external"] },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  const wasm = outputs.find(o => o.type === "asset" && o.fileName.endsWith(".wasm"));
  assert(wasm, "the real Vite build must emit a WASM asset");
  const chunks = outputs.filter(o => o.type === "chunk").map(o => o.code).join("\\n");
  assert(chunks.includes("constants.mjs"), "the consumer's external helper import must remain external");
  assert(chunks.includes("@unworklet/core"), "the framework package must remain external");
  assert(chunks.includes("reload-external"), "ordinary package imports must remain external");
  return Buffer.from(wasm.source);
}

const levels = [];
for (const level of [0.25, 0.25, 0.75, 1, 0.5]) {
  if (level === 0.75) {
    await writeFile(helper, 'import { OFFSET } from "../outside.mjs"; export const LEVEL = 0.75 + OFFSET;\\n');
    await utimes(helper, helperStat.atime, helperStat.mtime);
  }
  if (level === 1) {
    await writeFile(outside, "export const OFFSET = 0.25;\\n");
    await utimes(outside, outsideStat.atime, outsideStat.mtime);
  }
  if (level === 0.5) {
    await writeFile(entry, (await readFile(entry, "utf8")).replace("write(LEVEL)", "write(LEVEL / 2)"));
    await utimes(entry, entryStat.atime, entryStat.mtime);
  }
  assert.deepEqual(await buildWasm(), Buffer.from(await expected(level)), "emitted WASM must compile current level " + level);
  levels.push(level);
}
const plugin = unworklet();
assert.deepEqual(await buildWasm(plugin), Buffer.from(await expected(0.5)));
await writeFile(outside, "throw new Error('helper failed');\\n");
await assert.rejects(buildWasm(plugin), /helper failed/);
await writeFile(outside, "export const OFFSET = 0.75;\\n");
await utimes(outside, outsideStat.atime, outsideStat.mtime);
assert.deepEqual(await buildWasm(plugin), Buffer.from(await expected(0.75)));
console.log(JSON.stringify(levels));
`,
  );
  try {
    const stdout = execFileSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual([0.25, 0.25, 0.75, 1, 0.5]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 100_000);
