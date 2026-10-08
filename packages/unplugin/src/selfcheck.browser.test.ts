import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { build, createServer, preview, type Plugin } from "vite-plus";
import { expect, test } from "vite-plus/test";

import { closeHmrServer } from "./hmr-fixture.ts";
import unworklet from "./index.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const processorSource = `
import { audioOutput, defineProcessor, event, forSample } from "@unworklet/core";
export const probe = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const events = event({ to: "main", name: "probe", capacity: 16 });
  return { process() {
    events.emitIf(false, { atSample: 0, value: 0 });
    forSample(i => out.ch(0).at(i).write(0.25));
  } };
});
`;
const appSource = `
import { createNode } from "@unworklet/core";
import processor from "./probe.processor.mjs?worklet";
globalThis.runSelfcheck = async (corrupt, flag) => {
  globalThis.selfcheckProgress = "creating node";
  const context = new OfflineAudioContext(1, 128, 48000);
  const node = await createNode(context, processor);
  globalThis.selfcheckProgress = "awaiting fault injection";
  const violations = [];
  const done = new Promise((resolve, reject) => {
    node.node.addEventListener("processorerror", () => reject(new Error("processorerror")));
    node.node.port.addEventListener("message", ({data}) => {
      if (data.kind === "selfcheck-violation") violations.push(data);
      if (data.kind === "selfcheck-test-complete") resolve(data);
    });
  });
  node.node.port.postMessage({ kind: "selfcheck-test-inject", corrupt, flag });
  // Acknowledgment precedes rendering so the fault cannot race the quantum.
  await new Promise(resolve => {
    node.node.port.addEventListener("message", ({data}) => {
      if (data.kind === "selfcheck-test-ready") resolve();
    });
  });
  try {
    globalThis.selfcheckProgress = "rendering";
    node.outputs.main.connect(context.destination);
    const buffer = await context.startRendering();
    globalThis.selfcheckProgress = "awaiting quantum completion";
    const completed = await done;
    return { violations, completed, samples: Array.from(buffer.getChannelData(0)) };
  } finally {
    node.dispose();
  }
};
`;

// Only the emitted entry is instrumented. The runtime and its imports travel
// through the real plugin pipeline. Negative overflow cannot affect DSP loops.
function instrumentWorklet(): Plugin {
  return {
    name: "selfcheck-test-fault",
    enforce: "post",
    transform(code, id) {
      if (!id.startsWith("\0unworklet-worklet:")) return;
      expect(code).toContain("__unworkletNs.initialize(this, opts);");
      expect(code).toContain("return __unworkletNs.process(this, inputs, outputs, parameters);");
      return code
        .replace(
          "__unworkletNs.initialize(this, opts);",
          `__unworkletNs.initialize(this, opts);
    this.port.addEventListener("message", ({data}) => {
      if (data.kind !== "selfcheck-test-inject") return;
      if (data.flag === null) delete globalThis[["__UNWORKLET", "SELFCHECK__"].join("_")];
      else globalThis[["__UNWORKLET", "SELFCHECK__"].join("_")] = data.flag;
      const key = Object.getOwnPropertySymbols(this).find(s => s.description === "unworklet.workletState");
      this[key].eventRingsWasmHeaderViews[0][2] = data.corrupt ? -1 : 0;
      this.port.postMessage({kind: "selfcheck-test-ready"});
    });
    this.port.start();`,
        )
        .replace(
          "return __unworkletNs.process(this, inputs, outputs, parameters);",
          `const result = __unworkletNs.process(this, inputs, outputs, parameters);
    this.port.postMessage({kind: "selfcheck-test-complete", flag: globalThis[["__UNWORKLET", "SELFCHECK__"].join("_")] ?? null});
    return result;`,
        );
    },
  };
}

test.each([
  { command: "serve", delivery: "source", optimization: "direct" },
  { command: "build", delivery: "source", optimization: "direct" },
  { command: "serve", delivery: "packed", optimization: "direct" },
  { command: "serve", delivery: "packed", optimization: "prebundle" },
  { command: "build", delivery: "packed", optimization: "direct" },
] as const)(
  "real Vite $command $delivery $optimization worklet applies the self-check gate in its own realm",
  async ({ command, delivery, optimization }) => {
    const installed = process.env.UWK_SELFCHECK_CONSUMER_ROOT;
    const root = await mkdtemp(path.join(installed ?? tmpdir(), "unworklet-selfcheck-"));
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let closeServer: (() => Promise<void>) | undefined;
    try {
      await mkdir(path.join(root, "node_modules/@unworklet"), { recursive: true });
      let plugin = unworklet;
      if (delivery === "source") {
        await symlink(
          path.join(repo, "packages/core"),
          path.join(root, "node_modules/@unworklet/core"),
        );
      } else if (installed) {
        plugin = (
          await import(
            pathToFileURL(path.join(installed, "node_modules/@unworklet/unplugin/dist/index.mjs"))
              .href
          )
        ).default;
      } else {
        for (const name of ["core", "lang", "unplugin"]) {
          execFileSync(
            path.join(repo, "node_modules/.bin/vp"),
            ["pm", "pack", "--pack-destination", root],
            {
              cwd: path.join(repo, "packages", name),
              stdio: "pipe",
              timeout: 30_000,
            },
          );
          const tarball = (await readdir(root)).find(
            (file) => file.startsWith(`unworklet-${name}-`) && file.endsWith(".tgz"),
          )!;
          const target = path.join(root, "node_modules/@unworklet", name);
          await mkdir(target);
          execFileSync("tar", [
            "-xf",
            path.join(root, tarball),
            "--strip-components=1",
            "-C",
            target,
          ]);
        }
        for (const name of ["devframe", "magic-string", "typescript", "unplugin", "vite"]) {
          await symlink(
            path.join(repo, "packages/unplugin/node_modules", name),
            path.join(root, "node_modules", name),
          );
        }
        await symlink(
          path.join(repo, "packages/core/node_modules/binaryen"),
          path.join(root, "node_modules/binaryen"),
        );
        await symlink(
          path.join(repo, "packages/lang/node_modules/@volar"),
          path.join(root, "node_modules/@volar"),
        );
        plugin = (
          await import(
            pathToFileURL(path.join(root, "node_modules/@unworklet/unplugin/dist/index.mjs")).href
          )
        ).default;
      }
      await writeFile(
        path.join(root, "index.html"),
        '<script type="module" src="/main.mjs"></script>',
      );
      await writeFile(path.join(root, "main.mjs"), appSource);
      await writeFile(path.join(root, "probe.processor.mjs"), processorSource);
      const config = {
        root,
        configFile: false as const,
        logLevel: "error" as const,
        plugins: [plugin() as Plugin, instrumentWorklet()],
        server: {
          host: "127.0.0.1",
          port: 0,
          fs: { allow: [root, repo, ...(installed ? [installed] : [])] },
        },
        preview: { host: "127.0.0.1", port: 0 },
        ssr: { noExternal: [/^@unworklet\//] },
        build: { target: "esnext" },
        optimizeDeps: {
          // The dynamic addModule import must be in the initial optimizer graph;
          // otherwise Vite reloads the page while the observation is in flight.
          ...(optimization === "prebundle"
            ? { include: ["@unworklet/core", "@unworklet/core/worklet"] }
            : { exclude: ["@unworklet/core", "@unworklet/core/worklet"] }),
          esbuildOptions: { target: "esnext" },
        },
      };
      const vite: Pick<typeof import("vite-plus"), "build" | "createServer" | "preview"> = process
        .env.UWK_SELFCHECK_VITE_MODULE
        ? await import(process.env.UWK_SELFCHECK_VITE_MODULE)
        : { build, createServer, preview };
      let url: string;
      if (command === "serve") {
        const server = await vite.createServer(config);
        closeServer = () => closeHmrServer(server);
        await server.listen();
        url = server.resolvedUrls!.local[0]!;
      } else {
        const result = await vite.build(config);
        const output = (Array.isArray(result) ? result : [result]).flatMap((result) =>
          "output" in result ? result.output : [],
        );
        const chunks = new Map(
          output.filter((chunk) => chunk.type === "chunk").map((chunk) => [chunk.fileName, chunk]),
        );
        const assets = path.join(root, "dist/assets");
        const worklets = (await readdir(assets)).filter(
          (name) => name.endsWith(".js") && name.includes("worklet"),
        );
        expect(worklets.length).toBeGreaterThan(0);
        const pending = worklets.map((name) => `assets/${name}`);
        const visited = new Set<string>();
        while (pending.length > 0) {
          const name = pending.pop()!;
          if (visited.has(name)) continue;
          visited.add(name);
          const chunk = chunks.get(name)!;
          expect(chunk).toBeDefined();
          const code = await readFile(path.join(root, "dist", name), "utf8");
          expect(code).not.toContain("__UNWORKLET_SELFCHECK__");
          expect(code).not.toContain("selfcheck-violation");
          expect(code).not.toContain("ring overflow counter is negative");
          pending.push(...chunk.imports, ...chunk.dynamicImports);
        }
        const server = await vite.preview(config);
        closeServer = () =>
          new Promise<void>((resolve, reject) =>
            server.httpServer.close((error) => (error ? reject(error) : resolve())),
          );
        url = server.resolvedUrls!.local[0]!;
      }
      browser = await chromium.launch();
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(url);
      await page.waitForFunction("typeof globalThis.runSelfcheck === 'function'");
      for (const [corrupt, flag] of [false, true].flatMap((corrupt) =>
        [null, false, true].map((flag) => [corrupt, flag]),
      )) {
        await page.evaluate(`globalThis.selfcheckResult = undefined;
          globalThis.selfcheckFailure = undefined;
          globalThis.runSelfcheck(${corrupt}, ${flag}).then(
            result => globalThis.selfcheckResult = result,
            error => globalThis.selfcheckFailure = String(error),
          );`);
        await page
          .waitForFunction(
            "globalThis.selfcheckResult !== undefined || globalThis.selfcheckFailure !== undefined",
            undefined,
            { timeout: 10_000 },
          )
          .catch(async (error) => {
            throw new Error(
              `${String(error)}; progress=${String(await page.evaluate("globalThis.selfcheckProgress"))}; errors=${JSON.stringify(errors)}`,
              { cause: error },
            );
          });
        expect(await page.evaluate("globalThis.selfcheckFailure")).toBeUndefined();
        const result = await page.evaluate<{
          completed: unknown;
          samples: number[];
          violations: unknown[];
        }>("globalThis.selfcheckResult");
        expect(result.completed).toEqual({ kind: "selfcheck-test-complete", flag });
        expect(result.samples).toEqual(Array(128).fill(0.25));
        expect(result.violations).toEqual(
          command === "serve" && corrupt
            ? [
                {
                  kind: "selfcheck-violation",
                  ring: "event[0]",
                  detail: "ring overflow counter is negative: -1",
                },
              ]
            : [],
        );
      }
      expect(
        errors.filter((error) => !error.startsWith("unworklet: audio-thread self-check violation")),
      ).toEqual([]);
    } finally {
      await browser?.close();
      await closeServer?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);
