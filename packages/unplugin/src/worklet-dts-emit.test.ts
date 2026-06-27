/**
 * The plugin emits the aggregate witness `.d.ts` as a side effect of loading a
 * `?worklet` virtual module: after `configResolved` fixes the project root, a
 * single `load` writes `<root>/.unworklet/worklets.d.ts` carrying the loaded
 * processor's param names. This is the dev/build wiring that makes the typed
 * `node.params` surface real for a consumer without any per-file reference.
 *
 * Behavior-level: drives the real plugin hooks against a real fixture processor
 * and asserts the file the plugin writes to disk.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

const FIXTURE = fileURLToPath(
  new URL("../__fixtures__/01-stereo-gain.processor.ts", import.meta.url),
);
const VIRTUAL_ID_PREFIX = "\0unworklet:";

type ConfigResolvedFn = (config: { command: string; root: string; base: string }) => void;
type LoadFn = (this: { emitFile: () => string; addWatchFile: () => void }, id: string) => unknown;
type ResolveIdFn = (
  source: string,
  importer: string | undefined,
  options: { isEntry: boolean },
) => unknown;
type HotFn = (ctx: {
  file: string;
  server: { moduleGraph: { getModuleById: () => unknown; invalidateModule: () => void } };
  modules: unknown[];
  read: () => Promise<string>;
}) => Promise<unknown>;

const mockCtx = (): { emitFile: () => string; addWatchFile: () => void } => ({
  emitFile: () => "ref",
  addWatchFile: () => {},
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "uwk-emit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("load writes an aggregate witness d.ts under the project root", async () => {
  const plugin = unworklet();
  (plugin.configResolved as unknown as ConfigResolvedFn)({ command: "serve", root, base: "/" });
  await (plugin.load as unknown as LoadFn).call(mockCtx(), `${VIRTUAL_ID_PREFIX}${FIXTURE}`);

  const witness = path.join(root, ".unworklet", "worklets.d.ts");
  expect(existsSync(witness)).toBe(true);
  const content = readFileSync(witness, "utf8");
  expect(content).toContain("01-stereo-gain.processor.ts?worklet");
  expect(content).toContain("gain");
});

test("configResolved SYNCHRONOUSLY seeds .unworklet/ (tsconfig + witness) so the extends resolves before the build reads it", () => {
  const plugin = unworklet();
  (plugin.configResolved as unknown as ConfigResolvedFn)({ command: "serve", root, base: "/" });
  // No tick: the files must exist the instant configResolved returns. Vite/Rolldown
  // reads the consumer's `{ "extends": "./.unworklet/tsconfig.json" }` at build
  // start, before any async write flushes — an async seed would fail the first
  // build with "Tsconfig not found". So the tsconfig (and an empty witness, the
  // `include` target) are written synchronously here.
  const tsconfig = path.join(root, ".unworklet", "tsconfig.json");
  expect(existsSync(tsconfig)).toBe(true);
  expect(existsSync(path.join(root, ".unworklet", "worklets.d.ts"))).toBe(true);
  const cfg = JSON.parse(readFileSync(tsconfig, "utf8")) as {
    compilerOptions: { types: string[]; plugins: { name: string }[] };
    include: string[];
  };
  expect(cfg.compilerOptions.types).toContain("@unworklet/unplugin/client");
  expect(cfg.compilerOptions.plugins).toContainEqual({ name: "@unworklet/lang/typescript-plugin" });
  expect(cfg.include).toContain("worklets.d.ts");
  // App source must be covered so `?worklet` imports get the witness types —
  // including .tsx, the source extension of a React/Solid app.
  expect(cfg.include).toContain("../**/*.ts");
  expect(cfg.include).toContain("../**/*.tsx");
});

test("handleHotUpdate re-emits the witness for an edited processor (no browser needed)", async () => {
  const plugin = unworklet();
  (plugin.configResolved as unknown as ConfigResolvedFn)({ command: "serve", root, base: "/" });
  // Register the source the way a `?worklet` import would, so the edit is ours.
  (plugin.resolveId as unknown as ResolveIdFn)(`${FIXTURE}?worklet`, undefined, { isEntry: false });
  const server = { moduleGraph: { getModuleById: () => null, invalidateModule: () => {} } };
  await (plugin.handleHotUpdate as unknown as HotFn)({
    file: FIXTURE,
    server,
    modules: [],
    read: async () => "",
  });
  const witness = path.join(root, ".unworklet", "worklets.d.ts");
  expect(readFileSync(witness, "utf8")).toContain("gain");
});

test("re-loading a `?worklet` rewrites neither tsconfig nor an unchanged witness (no dev reload loop)", async () => {
  // Regression: the dev server re-runs `load` on every page load. Vite watches
  // tsconfig files and re-emitting `.unworklet/tsconfig.json` (or churning the
  // witness mtime) made it clear its cache and full-reload, which re-ran `load`,
  // which re-emitted — an infinite reload loop. `load` must touch neither file
  // when nothing changed; the fixed tsconfig is written once by configResolved.
  const plugin = unworklet();
  (plugin.configResolved as unknown as ConfigResolvedFn)({ command: "serve", root, base: "/" });
  const tsconfig = path.join(root, ".unworklet", "tsconfig.json");
  const witness = path.join(root, ".unworklet", "worklets.d.ts");
  const tsconfigMtime = statSync(tsconfig).mtimeMs;

  await (plugin.load as unknown as LoadFn).call(mockCtx(), `${VIRTUAL_ID_PREFIX}${FIXTURE}`);
  const witnessMtimeAfterFirst = statSync(witness).mtimeMs;

  // Second load of the same processor — as a page reload would do.
  await (plugin.load as unknown as LoadFn).call(mockCtx(), `${VIRTUAL_ID_PREFIX}${FIXTURE}`);

  // tsconfig untouched by any load; witness not rewritten when its content is the same.
  expect(statSync(tsconfig).mtimeMs).toBe(tsconfigMtime);
  expect(statSync(witness).mtimeMs).toBe(witnessMtimeAfterFirst);
});
