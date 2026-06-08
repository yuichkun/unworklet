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

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("configResolved alone creates the witness file so the vite-env reference resolves", async () => {
  const plugin = unworklet();
  (plugin.configResolved as unknown as ConfigResolvedFn)({ command: "serve", root, base: "/" });
  // configResolved kicks off the write fire-and-forget; give it a tick.
  await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(path.join(root, ".unworklet", "worklets.d.ts"))).toBe(true);
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
