import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";

import unworklet from "./index.ts";
import { defineDevSelfcheck } from "./selfcheck-define.ts";

const core = path.dirname(fileURLToPath(import.meta.resolve("@unworklet/core/package.json")));
const runtime = path.join(core, "src/worklet.ts");

type Transform = (
  code: string,
  id: string,
) =>
  | { code: string; map: unknown }
  | undefined
  | Promise<{ code: string; map: unknown } | undefined>;

async function configuredTransform(command: "serve" | "build") {
  const root = await mkdtemp(path.join(tmpdir(), "uwk-selfcheck-define-"));
  const plugin = unworklet();
  (plugin.configResolved as unknown as (config: unknown) => void)({
    command,
    root,
    base: "/",
  });
  return {
    transform: plugin.transform as Transform,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test.each([runtime, path.join(core, "dist/worklet-abc.mjs?v=123")])(
  "serve replaces the existing self-check identifier before module evaluation (%s)",
  async (id) => {
    const { transform, close } = await configuredTransform("serve");
    try {
      const result = await transform(
        'export const enabled = typeof __UNWORKLET_SELFCHECK__ !== "undefined" && __UNWORKLET_SELFCHECK__ === true;',
        id,
      );
      expect(result).toBeDefined();
      expect(result!.code).not.toContain("__UNWORKLET_SELFCHECK__");
      expect(result!.map).toBeTruthy();
      const module = await import(`data:text/javascript,${encodeURIComponent(result!.code)}`);
      expect(module.enabled).toBe(true);
    } finally {
      await close();
    }
  },
);

test("only free value references change; local bindings, text, property names and other flags stay byte-identical", () => {
  const source = `declare const __UNWORKLET_SELFCHECK__: boolean;
// __UNWORKLET_SELFCHECK__
const text = "__UNWORKLET_SELFCHECK__";
const blob = new Blob([\`__UNWORKLET_SELFCHECK__\`]);
const object = { __UNWORKLET_SELFCHECK__: 1 };
const member = object.__UNWORKLET_SELFCHECK__;
function shadow(__UNWORKLET_SELFCHECK__: boolean) { return __UNWORKLET_SELFCHECK__; }
function local() { const __UNWORKLET_SELFCHECK__ = false; return __UNWORKLET_SELFCHECK__; }
const other = typeof __UNWORKLET_DEVTOOLS__;
export const enabled = typeof __UNWORKLET_SELFCHECK__ !== "undefined" && __UNWORKLET_SELFCHECK__ === true;
`;
  const result = defineDevSelfcheck(source, runtime)!;
  expect(result.code).toBe(
    source.replace(
      'typeof __UNWORKLET_SELFCHECK__ !== "undefined" && __UNWORKLET_SELFCHECK__ === true',
      'typeof true !== "undefined" && true === true',
    ),
  );
  const map = new SourceMap(JSON.parse(result.map.toString()));
  const generated = result.code.split("\n")[9]!;
  const original = source.split("\n")[9]!;
  expect(map.findEntry(9, generated.lastIndexOf("true"))).toMatchObject({
    originalLine: 9,
    originalColumn: original.lastIndexOf("true"),
  });
});

for (const file of [runtime, path.join(core, "dist/worklet-fixture.mjs")]) {
  test.each([
    'const text = "__UNWORKLET_SELFCHECK__";',
    "__UNWORKLET_SELFCHECK__: for (;;) { break __UNWORKLET_SELFCHECK__; }",
    "__UNWORKLET_SELFCHECK__: for (;;) { continue __UNWORKLET_SELFCHECK__; }",
    "const __UNWORKLET_SELFCHECK__ = false; export { __UNWORKLET_SELFCHECK__ };",
    'import { __UNWORKLET_SELFCHECK__ } from "./other"; console.log(__UNWORKLET_SELFCHECK__);',
    "function f(__UNWORKLET_SELFCHECK__) { return { __UNWORKLET_SELFCHECK__ }; }",
    "type T = typeof __UNWORKLET_SELFCHECK__; // __UNWORKLET_SELFCHECK__",
  ])("does not rewrite a runtime with no free value use: %s", (source) => {
    expect(defineDevSelfcheck(source, file)).toBeUndefined();
  });
}
test("finds installed and linked core runtimes by package identity, not the plugin's own peer location", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uwk-installed-selfcheck-"));
  try {
    await mkdir(path.join(root, "dist"));
    const manifest = path.join(root, "package.json");
    const file = path.join(root, "dist/worklet-fixture.mjs");
    const code = "export const enabled = __UNWORKLET_SELFCHECK__;";
    expect(defineDevSelfcheck(code, file)).toBeUndefined();
    await writeFile(manifest, '{"name":"consumer"}');
    expect(defineDevSelfcheck(code, file)).toBeUndefined();
    await writeFile(manifest, '{"name":"@unworklet/core"}');
    expect(defineDevSelfcheck(code, file)?.code).toBe("export const enabled = true;");
    expect(defineDevSelfcheck(code, path.join(root, "dist/other.mjs"))).toBeUndefined();
    await writeFile(manifest, "{");
    expect(defineDevSelfcheck(code, file)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    command: "build" as const,
    code: "export const enabled = __UNWORKLET_SELFCHECK__;",
    id: runtime,
  },
  { command: "serve" as const, code: "export const value = 1;", id: runtime },
  { command: "serve" as const, code: ".__UNWORKLET_SELFCHECK__ { color: red; }", id: "/style.css" },
  {
    command: "serve" as const,
    code: 'export const text = "__UNWORKLET_SELFCHECK__"; const custom = <Custom />;',
    id: "/consumer.tsx",
  },
])("$command leaves $id to its existing pipeline", async ({ command, code, id }) => {
  const { transform, close } = await configuredTransform(command);
  try {
    expect(await transform(code, id)).toBeUndefined();
  } finally {
    await close();
  }
});

test("Vite composes the runtime edit map with its TypeScript transform", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uwk-selfcheck-map-"));
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [unworklet()],
    server: { watch: null, fs: { allow: [core, root] } },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const result = await server.transformRequest(`/@fs/${runtime}`);
    const original = await readFile(runtime, "utf8");
    const sourceAt = original.indexOf("typeof __UNWORKLET_SELFCHECK__") + "typeof ".length;
    const generatedAt = result!.code.indexOf("typeof true") + "typeof ".length;
    expect(generatedAt).toBeGreaterThan("typeof ".length);
    const location = (code: string, at: number) => {
      const lines = code.slice(0, at).split("\n");
      return { line: lines.length - 1, column: lines.at(-1)!.length };
    };
    const before = location(original, sourceAt);
    const after = location(result!.code, generatedAt);
    const map = new SourceMap(JSON.parse(JSON.stringify(result!.map)));
    expect(map.findEntry(after.line, after.column)).toMatchObject({
      originalLine: before.line,
      originalColumn: before.column,
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
