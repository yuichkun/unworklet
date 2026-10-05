import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { discoverWorkletImports } from "./worklet-discovery.ts";

let root: string;
const write = (name: string, text: string): void => {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "uwk-discovery-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("discovers static imports, reexports and literal dynamic imports, not comments or strings", () => {
  write(
    "main.ts",
    `
import one from "./one.ts?worklet";
export * from "./two.ts?worklet";
const load = () => import(\`./three.ts?worklet\`);
const dynamic = (name: string) => import(name);
const example = 'import fake from "./fake.ts?worklet"';
// import fake from "./comment.ts?worklet";
export {};
`,
  );
  expect(discoverWorkletImports(root).map((x) => x.source)).toEqual([
    "./one.ts?worklet",
    "./two.ts?worklet",
    "./three.ts?worklet",
  ]);
});

test("ignores declaration output, generated directories, dependencies and files without imports", () => {
  for (const file of [
    "out.d.ts",
    "out.d.mts",
    "node_modules/a/main.ts",
    "dist/main.js",
    ".unworklet/main.ts",
  ]) {
    write(file, 'import gone from "./gone.ts?worklet";');
  }
  write("empty.ts", "export const answer = 42;");
  write("main.js", 'import live from "./live.js?worklet";');
  expect(discoverWorkletImports(root)).toEqual([
    { source: "./live.js?worklet", importer: path.join(root, "main.js") },
  ]);
});

test("honors the tsconfig file set without falling back when it is empty", () => {
  write("main.ts", 'import one from "./one.ts?worklet";');
  write("tsconfig.json", JSON.stringify({ files: [] }));
  expect(discoverWorkletImports(root)).toEqual([]);
  write("tsconfig.json", JSON.stringify({ files: ["main.ts"] }));
  expect(discoverWorkletImports(root)).toEqual([
    { source: "./one.ts?worklet", importer: path.join(root, "main.ts") },
  ]);
});

test("a malformed tsconfig does not expand discovery to unrelated project files", () => {
  write("main.ts", 'import one from "./one.ts?worklet";');
  write("tsconfig.json", "{ broken config");
  expect(discoverWorkletImports(root)).toEqual([]);
});

test("malformed reference entries do not break discovery and corrected config recovers", () => {
  write("main.ts", 'import tone from "./tone.ts?worklet";');
  write("tsconfig.json", JSON.stringify({ references: [null] }));
  expect(discoverWorkletImports(root)).toEqual([]);
  write("tsconfig.json", JSON.stringify({ files: ["main.ts"] }));
  expect(discoverWorkletImports(root)).toEqual([
    { source: "./tone.ts?worklet", importer: path.join(root, "main.ts") },
  ]);
});

test("follows referenced app configs and terminates cycles without duplicate imports", () => {
  write("src/main.ts", 'import tone from "./tone.ts?worklet";');
  write(
    "tsconfig.json",
    JSON.stringify({
      files: [],
      references: [{ path: "./tsconfig.app.json" }, { path: "./other" }],
    }),
  );
  write(
    "tsconfig.app.json",
    JSON.stringify({ include: ["src"], references: [{ path: "./tsconfig.json" }] }),
  );
  write(
    "other/tsconfig.json",
    JSON.stringify({ files: ["../src/main.ts"], references: [{ path: "../missing" }] }),
  );
  expect(discoverWorkletImports(root)).toEqual([
    { source: "./tone.ts?worklet", importer: path.join(root, "src/main.ts") },
  ]);
});

test("discovers worklet query parameters in any position and type imports", () => {
  write(
    "main.ts",
    `
import first from "./one.ts?raw&worklet";
type Second = typeof import("./two.ts?worklet");
`,
  );
  expect(discoverWorkletImports(root).map((x) => x.source)).toEqual([
    "./one.ts?raw&worklet",
    "./two.ts?worklet",
  ]);
});
