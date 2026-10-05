import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { createServer, type Plugin } from "vite-plus";
import { expect, test } from "vite-plus/test";

import unworklet from "./index.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const processorSource = (
  name: string,
  multiplier: number,
  marker: string,
  helper = false,
): string => `
${helper ? 'import { NAME, MULTIPLIER, MARKER } from "./settings.mjs";' : ""}
import { audioOutput, defineProcessor, forSample, param } from "@unworklet/core";
export const tone = defineProcessor(() => {
  const p = param.f32({ default: 0.25, min: 0, max: 1, automationRate: "a-rate" }).named(${helper ? "NAME" : JSON.stringify(name)});
  const out = audioOutput({ channels: 1, name: "main" });
  return { process: () => forSample(i => out.ch(0).at(i).write(p.at(i).mul(${helper ? "MULTIPLIER" : multiplier}))) };
}, { id: ${helper ? "MARKER" : JSON.stringify(marker)}, migrations: [{ from: "old", to: ${helper ? "MARKER" : JSON.stringify(marker)}, migrate() {} }] });
`;

const appSource = `
import { createNode } from "@unworklet/core";
import tone from "./tone.processor.mjs?worklet";
const context = new AudioContext({ sampleRate: 48000 });
await context.resume();
globalThis.snapshots = [];
globalThis.failures = [];
globalThis.context = context;
globalThis.nodes = [];
let analyser;
async function capture(processor) {
  const node = await createNode(context, processor);
  for (const old of globalThis.nodes) old.outputs.main.disconnect();
  globalThis.nodes.push(node);
  analyser = context.createAnalyser();
  analyser.fftSize = 256;
  node.outputs.main.connect(analyser);
  analyser.connect(context.destination);
  const wasm = Array.from(new Uint8Array(await (await fetch(processor.worklet.wasmUrl)).arrayBuffer()));
  globalThis.snapshots.push({
    names: Array.from(node.node.parameters.keys()),
    mapped: Object.keys(node.params),
    descriptors: processor.worklet.parameterDescriptors.map(p => p.name),
    processorName: processor.worklet.processorName,
    moduleUrl: processor.worklet.moduleUrl,
    wasmUrl: processor.worklet.wasmUrl,
    migration: processor.migrations[0].to,
    id: processor.id,
    wasm,
  });
}
globalThis.amplitude = () => {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  return Math.max(...samples);
};
if (import.meta.hot) {
  import.meta.hot.accept("./tone.processor.mjs?worklet", updated => {
    capture(updated.default).catch(error => globalThis.failures.push(String(error)));
  });
}
await capture(tone);
`;

type Snapshot = {
  names: string[];
  mapped: string[];
  descriptors: string[];
  processorName: string;
  moduleUrl: string;
  wasmUrl: string;
  migration: string;
  id: string;
  wasm: number[];
};

test.each([
  { label: "metadata-only", multiplier: 1, name: "volume", helper: false },
  { label: "DSP and metadata", multiplier: 2, name: "volume", helper: false },
  { label: "namespace-only", multiplier: 1, name: "gain", helper: false },
  { label: "transitive helper", multiplier: 2, name: "volume", helper: true },
])(
  "real Vite HMR updates $label edits in the same AudioContext",
  async ({ multiplier, name, helper }) => {
    const root = await mkdtemp(path.join(tmpdir(), "unworklet-hmr-"));
    await mkdir(path.join(root, "node_modules/@unworklet"), { recursive: true });
    await symlink(
      path.join(repo, "packages/core"),
      path.join(root, "node_modules/@unworklet/core"),
    );
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/main.mjs"></script>',
    );
    await writeFile(path.join(root, "main.mjs"), appSource);
    const source = path.join(root, "tone.processor.mjs");
    await writeFile(source, processorSource("gain", 1, "before", helper));
    const settings = path.join(root, "settings.mjs");
    await writeFile(settings, 'export const NAME = "gain", MULTIPLIER = 1, MARKER = "before";');
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "error",
      plugins: [unworklet() as Plugin],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root, repo] } },
      resolve: { conditions: ["development"] },
      ssr: { noExternal: [/^@unworklet\//] },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.resolvedUrls!.local[0]!);
      await page.waitForFunction("globalThis.snapshots?.length === 1");
      await page.waitForFunction("Math.abs(globalThis.amplitude() - 0.25) < 0.001");
      const first = (await page.evaluate<Snapshot[]>("globalThis.snapshots"))[0]!;
      const firstModule = await (await fetch(new URL(first.moduleUrl, page.url()))).text();
      if (helper) {
        await writeFile(
          settings,
          `export const NAME = ${JSON.stringify(name)}, MULTIPLIER = ${multiplier}, MARKER = "after";`,
        );
      } else {
        await writeFile(source, processorSource(name, multiplier, "after"));
      }
      await page.waitForFunction(
        "globalThis.snapshots?.length === 2 || globalThis.failures?.length > 0",
      );
      expect(await page.evaluate("globalThis.failures")).toEqual([]);
      const second = (await page.evaluate<Snapshot[]>("globalThis.snapshots"))[1]!;
      expect(second.descriptors).toEqual([name]);
      expect(second.names).toEqual([name]);
      expect(second.mapped).toEqual([name]);
      expect(second.id).toBe("after");
      expect(second.migration).toBe("after");
      if (name === "gain") {
        expect(second.processorName).toBe(first.processorName);
        expect(second.moduleUrl).toBe(first.moduleUrl);
        expect(second.wasmUrl).toBe(first.wasmUrl);
      } else {
        expect(second.processorName).not.toBe(first.processorName);
        expect(second.moduleUrl).not.toBe(first.moduleUrl);
        expect(second.wasmUrl).not.toBe(first.wasmUrl);
      }
      if (multiplier === 1) expect(second.wasm).toEqual(first.wasm);
      else expect(second.wasm).not.toEqual(first.wasm);
      expect(await (await fetch(new URL(first.moduleUrl, page.url()))).text()).toBe(firstModule);
      expect(
        await page.evaluate(
          "globalThis.nodes.every(node => node.node.context === globalThis.context)",
        ),
      ).toBe(true);
      expect(await page.evaluate("Array.from(globalThis.nodes[0].node.parameters.keys())")).toEqual(
        ["gain"],
      );
      await page.waitForFunction(`Math.abs(globalThis.amplitude() - ${0.25 * multiplier}) < 0.001`);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
