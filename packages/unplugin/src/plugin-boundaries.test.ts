import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vite-plus/test";

import unworklet from "./index.ts";

const fixture = fileURLToPath(
  new URL("../__fixtures__/01-stereo-gain.processor.ts", import.meta.url),
);
const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "uwk-plugin-boundary-"));
  roots.push(root);
  return root;
};
type LoadHook = (
  this: { emitFile: () => string; addWatchFile: () => void },
  id: string,
) => Promise<string>;
const load = (plugin: ReturnType<typeof unworklet>, source: string): Promise<string> =>
  (plugin.load as unknown as LoadHook).call(
    { emitFile: () => "asset", addWatchFile: () => {} },
    `\0unworklet:${source}`,
  );
const configure = (plugin: ReturnType<typeof unworklet>, root: string): void => {
  (
    plugin.configResolved as unknown as (config: {
      command: string;
      root: string;
      base: string;
    }) => void
  )({ command: "build", root, base: "/" });
};

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("@unworklet/lang");
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  "stereoGain as default",
  "stereoGain as gain",
  "stereoGain as gain, stereoGain as default",
])("processor exports %s produce a valid consumer module", async (bindings) => {
  const root = temporaryRoot();
  const source = path.join(root, "gain.processor.ts");
  writeFileSync(source, `export { ${bindings} } from ${JSON.stringify(fixture)};\n`);
  const code = await load(unworklet(), source);
  expect(code).toContain("export default __unworkletAugmented;");
  expect(() =>
    execFileSync(process.execPath, ["--check", "--input-type=module"], {
      input: code,
      stdio: "pipe",
    }),
  ).not.toThrow();
  const generated = path.join(root, "generated.mjs");
  writeFileSync(generated, code);
  const namespace = (await import(generated)) as Record<string, unknown>;
  if (bindings.includes("as gain")) {
    expect(Object.keys(namespace).sort()).toEqual(["default", "gain"]);
    expect(namespace.gain).toBe(namespace.default);
  } else {
    expect(Object.keys(namespace)).toEqual(["default"]);
  }
});

test("witness write rejection warns once while processor compilation remains available", async () => {
  vi.resetModules();
  vi.doMock("node:fs/promises", async () => ({
    ...(await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")),
    writeFile: async () => {
      throw "filesystem adapter refused the write";
    },
  }));
  const { default: factory } = await import("./index.ts");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const plugin = factory();
  configure(plugin, temporaryRoot());
  const first = await load(plugin, fixture);
  const second = await load(plugin, fixture);
  expect(first).toContain("__unworkletAugmented");
  expect(second).toBe(first);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0]?.[0]).toContain("filesystem adapter refused the write");
});

test("a non-Error lowering rejection reaches the build diagnostic with its message", async () => {
  vi.resetModules();
  vi.doMock("@unworklet/lang", async () => ({
    ...(await vi.importActual<typeof import("@unworklet/lang")>("@unworklet/lang")),
    lowerUwkSource: () => {
      throw "syntax provider unavailable";
    },
  }));
  const { default: factory } = await import("./index.ts");
  const transform = factory().transform as unknown as (
    this: { error: (message: string) => never },
    code: string,
    id: string,
  ) => unknown;
  expect(() =>
    transform.call(
      {
        error: (message) => {
          throw new Error(message);
        },
      },
      "process(() => {});",
      "/processor.uwk.ts",
    ),
  ).toThrow("syntax provider unavailable");
});
