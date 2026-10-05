import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build, createServer, type Plugin } from "vite-plus";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const processorSource = (name: string): string => `
import { audioOutput, defineProcessor, forSample, param } from "@unworklet/core";
export const tone = defineProcessor(() => {
  const p = param.f32({ default: 0.25, min: 0, max: 1, automationRate: "a-rate" }).named(${JSON.stringify(name)});
  const out = audioOutput({ channels: 1, name: "main" });
  return { process: () => forSample(i => out.ch(0).at(i).write(p.at(i))) };
});
`;

let root: string;
let server: Awaited<ReturnType<typeof createServer>> | undefined;
const witness = (): Promise<string> =>
  readFile(path.join(root, ".unworklet/worklets.d.ts"), "utf8");
const start = async (plugins: Plugin[] = []): Promise<void> => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [unworklet() as Plugin, ...plugins],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, repo] } },
    optimizeDeps: { noDiscovery: true },
    ssr: { external: ["@unworklet/core"] },
  });
  await server.listen();
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "uwk-editor-startup-"));
  await mkdir(path.join(root, "node_modules/@unworklet"), { recursive: true });
  await symlink(path.join(repo, "packages/core"), path.join(root, "node_modules/@unworklet/core"));
  await writeFile(path.join(root, "index.html"), '<script type="module" src="/main.ts"></script>');
  await writeFile(
    path.join(root, "main.ts"),
    'import tone from "./tone.processor.ts?worklet"; console.log(tone);',
  );
  await writeFile(path.join(root, "tone.processor.ts"), processorSource("gain"));
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: "./.unworklet/tsconfig.json" }),
  );
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

test("cold dev startup generates precise types without a browser request", async () => {
  await start();
  expect(await witness()).toContain("tone.processor.ts?worklet");
  expect(await witness()).toContain('"gain"');
});

test("dev restart rebuilds current types instead of preserving stale declarations", async () => {
  await start();
  await server!.close();
  await writeFile(path.join(root, "tone.processor.ts"), processorSource("cutoff"));
  await start();
  expect(await witness()).toContain('"cutoff"');
  expect(await witness()).not.toContain('"gain"');
});

test("startup discovers sugar and plain filenames, ignores non-import text and never runs the app", async () => {
  await writeFile(
    path.join(root, "voice.uwk.ts"),
    'const level = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" }); const output = audioOutput({ channels: 2, name: "main" }); process(() => { forSample(i => { output.left[i] = level[i]; output.right[i] = level[i]; }); });',
  );
  await rename(path.join(root, "tone.processor.ts"), path.join(root, "plain.ts"));
  await writeFile(path.join(root, "orphan.ts"), "throw new Error('must not be evaluated');");
  await writeFile(
    path.join(root, "main.ts"),
    `
throw new Error("the app needs a browser");
export { default as tone } from "./plain.ts?worklet";
const later = () => import("./voice.uwk.ts?worklet");
// import orphan from "./orphan.ts?worklet";
const example = 'import orphan from "./orphan.ts?worklet";';
console.log(later, example);
`,
  );
  await start();
  expect(await witness()).toContain("plain.ts?worklet");
  expect(await witness()).toContain("voice.uwk.ts?worklet");
  expect(await witness()).toContain('"level"');
  expect(await witness()).not.toContain("orphan.ts");
});

test("renaming and deleting a processor offline removes orphaned types on restart", async () => {
  await start();
  await server!.close();
  await rename(path.join(root, "tone.processor.ts"), path.join(root, "renamed.ts"));
  await writeFile(path.join(root, "main.ts"), 'export { default } from "./renamed.ts?worklet";');
  await start();
  expect(await witness()).toContain("renamed.ts?worklet");
  expect(await witness()).not.toContain("tone.processor.ts?worklet");
  await server!.close();
  await rm(path.join(root, "renamed.ts"));
  await start();
  expect(await witness()).not.toContain("renamed.ts?worklet");
});

test("processor and helper edits update precise types before any browser connects", async () => {
  const source = path.join(root, "tone.processor.ts");
  await writeFile(
    source,
    `import { NAME } from "./settings.ts";\n${processorSource("gain").replace('"gain"', "NAME")}`,
  );
  await writeFile(path.join(root, "settings.ts"), 'export const NAME = "gain";');
  await start();
  expect(await witness()).toContain('"gain"');
  await writeFile(path.join(root, "settings.ts"), 'export const NAME = "cutoff";');
  await expect.poll(witness).toContain('"cutoff"');
  expect(await witness()).not.toContain('"gain"');
  await writeFile(source, processorSource("drive"));
  await expect.poll(witness).toContain('"drive"');
  expect(await witness()).not.toContain('"cutoff"');
});

test("adding and removing imports reconciles editor types without a browser", async () => {
  await start();
  await writeFile(path.join(root, "second.ts"), processorSource("mix"));
  await writeFile(path.join(root, "main.ts"), 'export { default } from "./second.ts?worklet";');
  await expect.poll(witness).toContain('"mix"');
  expect(await witness()).not.toContain("tone.processor.ts?worklet");
  await rm(path.join(root, "second.ts"));
  await expect.poll(witness).not.toContain("second.ts?worklet");
});

test("reusing a build plugin drops processors removed from the app", async () => {
  const plugin = unworklet() as Plugin;
  const compile = (): ReturnType<typeof build> =>
    build({
      root,
      configFile: false,
      logLevel: "error",
      plugins: [plugin],
      build: { write: false, rollupOptions: { external: ["@unworklet/core"] } },
    });
  await compile();
  expect(await witness()).toContain('"gain"');
  await writeFile(path.join(root, "main.ts"), "console.log('no processors');");
  await compile();
  expect(await witness()).toBe("");
});

test("a runtime-only processor keeps refreshing outside the editor discovery file set", async () => {
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ files: [] }));
  await start();
  expect(await witness()).toBe("");
  await server!.transformRequest("/main.ts");
  await server!.transformRequest(`\0unworklet:${path.join(root, "tone.processor.ts")}`);
  expect(await witness()).toContain('"gain"');
  await writeFile(path.join(root, "tone.processor.ts"), processorSource("cutoff"));
  await expect.poll(witness).toContain('"cutoff"');
  expect(await witness()).not.toContain('"gain"');
});

test("a discovered processor keeps refreshing after its import becomes plugin-generated", async () => {
  await start([
    {
      name: "runtime-processor-import",
      transform(code, id) {
        if (id === path.join(root, "main.ts") && code.includes("GENERATED_PROCESSOR")) {
          return 'import tone from "./tone.processor.ts?worklet"; console.log(tone);';
        }
      },
    },
  ]);
  await server!.transformRequest("/main.ts");
  await server!.transformRequest(`\0unworklet:${path.join(root, "tone.processor.ts")}`);
  expect(await witness()).toContain('"gain"');
  await writeFile(path.join(root, "main.ts"), "// GENERATED_PROCESSOR");
  await writeFile(path.join(root, "tone.processor.ts"), processorSource("cutoff"));
  await expect.poll(witness).toContain('"cutoff"');
  expect(await witness()).not.toContain('"gain"');
});

test.each(["remove import", "delete importer"])(
  "a runtime-only witness is pruned when its importer changes: %s",
  async (change) => {
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ files: [] }));
    let onProcessorUpdate = (): void => {};
    await start([
      {
        name: "observe-witness-refresh",
        enforce: "post",
        handleHotUpdate(ctx) {
          if (ctx.file === path.join(root, "tone.processor.ts")) onProcessorUpdate();
        },
      },
    ]);
    await server!.transformRequest("/main.ts");
    await server!.transformRequest(`\0unworklet:${path.join(root, "tone.processor.ts")}`);
    expect(await witness()).toContain('"gain"');
    if (change === "remove import") {
      await writeFile(path.join(root, "main.ts"), "console.log('no processor');");
    } else {
      await rm(path.join(root, "main.ts"));
    }
    await expect.poll(witness).toBe("");
    const refreshed = new Promise<void>((resolve) => {
      onProcessorUpdate = resolve;
    });
    await writeFile(path.join(root, "tone.processor.ts"), processorSource("cutoff"));
    await refreshed;
    expect(await witness()).toBe("");
  },
);

test("startup waits for other plugins to configure their virtual processor helpers", async () => {
  await writeFile(
    path.join(root, "tone.processor.ts"),
    `import { NAME } from "virtual:settings";\n${processorSource("gain").replace('"gain"', "NAME")}`,
  );
  let ready = false;
  await start([
    {
      name: "virtual-settings",
      configureServer() {
        ready = true;
      },
      resolveId(id) {
        if (id === "virtual:settings") return "\0virtual:settings";
      },
      load(id) {
        if (id !== "\0virtual:settings") return;
        if (!ready) throw new Error("helper plugin is not configured");
        return 'export const NAME = "gain";';
      },
    },
  ]);
  expect(await witness()).toContain('"gain"');
});

test("watch builds keep cached processor types and remove unused processors", async () => {
  const watcher = await build({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [unworklet() as Plugin],
    build: { write: false, watch: {}, rollupOptions: { external: ["@unworklet/core"] } },
  });
  if (!("on" in watcher)) throw new Error("expected a build watcher");
  const nextBuild = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const onEvent = (event: { code: string; error?: unknown }): void => {
        if (event.code === "END" || event.code === "ERROR") {
          watcher.off("event", onEvent);
          if (event.code === "ERROR") reject(event.error);
          else resolve();
        }
      };
      watcher.on("event", onEvent);
    });
  try {
    await nextBuild();
    expect(await witness()).toContain('"gain"');
    const edited = nextBuild();
    await writeFile(
      path.join(root, "main.ts"),
      'import tone from "./tone.processor.ts?worklet"; console.log("changed", tone);',
    );
    await edited;
    expect(await witness()).toContain('"gain"');
    const removed = nextBuild();
    await writeFile(path.join(root, "main.ts"), "console.log('no processors');");
    await removed;
    expect(await witness()).toBe("");
  } finally {
    await watcher.close();
  }
});
