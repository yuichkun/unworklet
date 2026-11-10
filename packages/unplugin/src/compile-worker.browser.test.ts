/**
 * Real Vite + Chromium: a `?worklet` processor created on an AudioContext at a
 * rate other than the build's 48000 Hz is compiled for the context in the
 * processor's compile worker — in the dev server and in a production build.
 *
 * `@unworklet/core` is installed the way a consumer gets it (the packed tarball:
 * published exports, `dist` only), so the dev server resolves the worker's
 * imports through its dependency optimizer exactly as in an app. In dev the
 * worker's dependencies must already be optimized: discovering them only when
 * the worker loads would make Vite re-optimize and reload the page.
 *
 * With `UWK_SELFCHECK_CONSUMER_ROOT` / `UWK_SELFCHECK_VITE_MODULE` pointing at an
 * isolated consumer that installed the packed packages and a specific Vite (as
 * the compatibility workflow prepares for the self-check test), the app is
 * created inside that consumer and driven with its plugin and Vite.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pathToFileURL } from "node:url";

import { chromium, type Page } from "playwright";
import { build, createServer, preview, type Plugin } from "vite-plus";
import { beforeAll, expect, test } from "vite-plus/test";

import { closeHmrServer } from "./hmr-fixture.ts";
import unworklet from "./index.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const VP = path.join(repo, "node_modules/.bin/vp");

const processorSource = `
import { audioOutput, defineProcessor, forSample, sin, state } from "@unworklet/core";
export const tone = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const phase = state.f32(0);
  return {
    process: () =>
      forSample((i) => {
        phase.write(phase.read().add(440 / ctx.sampleRate).mod(1));
        out.ch(0).at(i).write(sin(phase.read().mul(2 * Math.PI)).mul(0.5));
      }),
  };
});
`;

const appSource = `
import { createNode } from "@unworklet/core";
import tone from "./tone.processor.mjs?worklet";
globalThis.render = async (sampleRate) => {
  const context = new OfflineAudioContext({ numberOfChannels: 1, length: sampleRate / 2, sampleRate });
  const node = await createNode(context, tone);
  node.outputs.main.connect(context.destination);
  const buffer = await context.startRendering();
  return Array.from(buffer.getChannelData(0));
};
globalThis.ready = true;
`;

let installedCore = "";
const consumer = process.env.UWK_SELFCHECK_CONSUMER_ROOT;
type ViteApi = Pick<typeof import("vite-plus"), "build" | "createServer" | "preview">;
let vite: ViteApi = { build, createServer, preview };
let plugin: () => Plugin = () => unworklet() as Plugin;

beforeAll(async () => {
  if (consumer !== undefined) {
    vite = (await import(process.env.UWK_SELFCHECK_VITE_MODULE!)) as ViteApi;
    const installed = (await import(
      pathToFileURL(path.join(consumer, "node_modules/@unworklet/unplugin/dist/index.mjs")).href
    )) as { default: () => Plugin };
    plugin = () => installed.default();
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "unworklet-packed-core-"));
  execFileSync(VP, ["pm", "pack", "--pack-destination", dir], {
    cwd: path.join(repo, "packages/core"),
    stdio: "ignore",
  });
  const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"))!;
  execFileSync("tar", ["-xzf", path.join(dir, tarball), "-C", dir]);
  installedCore = path.join(dir, "package");
}, 180_000);

async function makeApp(): Promise<string> {
  const root = await mkdtemp(path.join(consumer ?? tmpdir(), "unworklet-compile-worker-"));
  if (consumer === undefined) {
    await mkdir(path.join(root, "node_modules/@unworklet"), { recursive: true });
    await cp(installedCore, path.join(root, "node_modules/@unworklet/core"), { recursive: true });
    await symlink(
      realpathSync(path.join(repo, "packages/core/node_modules/binaryen")),
      path.join(root, "node_modules/binaryen"),
    );
  }
  await writeFile(path.join(root, "index.html"), '<script type="module" src="/main.mjs"></script>');
  await writeFile(path.join(root, "main.mjs"), appSource);
  await writeFile(path.join(root, "tone.processor.mjs"), processorSource);
  return root;
}

/** Frequency from rising zero crossings over the whole render. */
function frequency(samples: number[], sampleRate: number): number {
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! < 0 && samples[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  return ((crossings - 1) * sampleRate) / (last - first);
}

type Observed = { navigations: number; workerHeaders: Array<Record<string, string>> };

/** Open the app, render at each rate, and report what the page saw. */
async function playAt(url: string, rates: number[]): Promise<Observed> {
  const browser = await chromium.launch();
  try {
    const page: Page = await browser.newPage();
    const errors: string[] = [];
    const observed: Observed = { navigations: 0, workerHeaders: [] };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) observed.navigations++;
    });
    page.on("response", (response) => {
      if (/compile-worker/.test(response.url()) && response.request().resourceType() !== "fetch") {
        observed.workerHeaders.push(response.headers());
      }
    });
    await page.goto(url);
    await page.waitForFunction("globalThis.ready === true");
    for (const sampleRate of rates) {
      const samples = await page.evaluate<number[]>(`globalThis.render(${sampleRate})`);
      expect(frequency(samples, sampleRate)).toBeCloseTo(440, 0);
    }
    // Give a late optimizer re-run the time to reload the page, if it would.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(errors).toEqual([]);
    return observed;
  } finally {
    await browser.close();
  }
}

test("dev server: a 44.1 kHz and a 96 kHz context play 440 Hz without reloading the page", async () => {
  const root = await makeApp();
  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [plugin()],
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const observed = await playAt(server.resolvedUrls!.local[0]!, [44_100, 96_000]);
    expect(observed.navigations).toBe(1);
    // A worker on a cross-origin-isolated page loads only with a compatible COEP.
    expect(observed.workerHeaders.length).toBeGreaterThan(0);
    for (const headers of observed.workerHeaders) {
      expect(headers["cross-origin-embedder-policy"]).toBe("credentialless");
    }
  } finally {
    await closeHmrServer(server);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("production build: the emitted compile worker plays 440 Hz at 44.1 kHz", async () => {
  const root = await makeApp();
  const outDir = path.join(root, "dist");
  await vite.build({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [plugin()],
    build: { outDir, emptyOutDir: true },
  });
  expect(
    readdirSync(path.join(outDir, "assets")).some((f) => /compile-worker.*\.js$/.test(f)),
  ).toBe(true);
  const server = await vite.preview({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [plugin()],
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0 },
  });
  try {
    const observed = await playAt(server.resolvedUrls!.local[0]!, [44_100]);
    expect(observed.workerHeaders.length).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
