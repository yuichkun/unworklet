import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseRemoteConnection } from "@vitejs/devtools-kit/client";
import { defineRpcFunction, type ViteDevToolsNodeContext } from "@vitejs/devtools-kit";
import { chromium } from "playwright";
import { createServer, type Plugin } from "vite-plus";
import { expect, test } from "vite-plus/test";
import { closeHmrServer } from "./hmr-fixture.ts";
import type {
  DevPages,
  DevPageSnapshots,
  PageMidiInject,
  PageMidiInjectCommand,
} from "./devtools-pages.ts";
import unworklet, { type DevMidiState } from "./index.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const demoRequire = createRequire(path.join(repo, "examples/demo/package.json"));
async function availablePort(): Promise<number> {
  const reservation = createNetServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const source = (id: string) => `
import { audioOutput, defineProcessor, event, forSample } from "@unworklet/core";
export const thru = defineProcessor(() => {
  const keys = event.midi({ from: "main", name: "in" });
  const sent = event.midi({ to: "main", name: "out" });
  const out = audioOutput({ channels: 1, name: "audio" });
  return { process: () => {
    forSample(i => out.ch(0).at(i).write(0));
    keys.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
      sent.emitIf(true, { type: "noteOn", channel, note, velocity, atSample });
    });
    keys.onEvent("noteOff", ({ channel, note, velocity, atSample }) => {
      sent.emitIf(true, { type: "noteOff", channel, note, velocity, atSample });
    });
  } };
}, { id: ${JSON.stringify(id)} });
`;
const main = `
import { createNode } from "@unworklet/core";
import { getDevToolsClientContext } from "@vitejs/devtools-kit/client";
globalThis.devtoolsStatus = () => getDevToolsClientContext()?.rpc.status;
globalThis.captureConnection = () => getDevToolsClientContext().rpc.call("anonymous:fixture-capture-connection");
import processor from "./thru.processor.mjs?worklet";
const context = new AudioContext({ sampleRate: 48000 });
await context.resume();
let node;
globalThis.received = [];
globalThis.released = [];
globalThis.generation = 0;
const start = async (processor) => {
  node?.dispose();
  node = await createNode(context, processor);
  node.outputs.audio.connect(context.destination);
  node.midi.out.onEvent("noteOn", e => globalThis.received.push(e.note));
  node.midi.out.onEvent("noteOff", e => globalThis.released.push(e.note));
  globalThis.generation++;
};
if (import.meta.hot) import.meta.hot.accept("./thru.processor.mjs?worklet", updated => start(updated.default));
await start(processor);
`;

test("real DevTools routes two same-app tabs independently across node HMR, page reload and close", async () => {
  const { DevTools } = await import(pathToFileURL(demoRequire.resolve("@vitejs/devtools")).href);
  const root = await mkdtemp(path.join(tmpdir(), "unworklet-devtools-pages-"));
  await mkdir(path.join(root, "node_modules/@unworklet"), { recursive: true });
  await mkdir(path.join(root, "node_modules/@vitejs"), { recursive: true });
  for (const name of ["core", "unplugin"])
    await symlink(
      path.join(repo, "packages", name),
      path.join(root, "node_modules/@unworklet", name),
    );
  await symlink(
    path.dirname(createRequire(import.meta.url).resolve("@vitejs/devtools-kit/package.json")),
    path.join(root, "node_modules/@vitejs/devtools-kit"),
  );
  await writeFile(
    path.join(root, "index.html"),
    '<title>Same app</title><script type="module" src="/main.mjs"></script>',
  );
  await writeFile(path.join(root, "main.mjs"), main);
  const processorPath = path.join(root, "thru.processor.mjs");
  await writeFile(processorPath, source("first"));
  let ctx!: ViteDevToolsNodeContext;
  let disconnectPage!: () => void;
  const capture = {
    name: "capture-devtools-test-context",
    devtools: {
      setup(value: ViteDevToolsNodeContext) {
        ctx = value;
        ctx.rpc.register(
          defineRpcFunction({
            name: "anonymous:fixture-capture-connection",
            type: "action",
            setup: () => ({
              handler: () => {
                const peer = ctx.rpc.getCurrentRpcSession()!.meta.peer!;
                disconnectPage = () => peer.close(1012, "connection lifecycle regression");
              },
            }),
          }) as Parameters<typeof ctx.rpc.register>[0],
        );
      },
    },
  } as Plugin;
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    plugins: [unworklet() as Plugin, capture, DevTools({ builtinDevTools: false })],
    server: {
      host: "127.0.0.1",
      port: await availablePort(),
      strictPort: true,
      fs: { allow: [root, repo] },
    },
    resolve: { conditions: ["development"] },
    ssr: { noExternal: [/^@unworklet\//] },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const browserContext = await browser.newContext();
    const dock = ctx.docks.values().find((entry) => entry.id === "unworklet");
    if (!dock || dock.type !== "iframe") throw new Error("unworklet dock was not registered");
    const panelUrl = new URL(dock.url, ctx.host.resolveOrigin());
    const descriptor = parseRemoteConnection(panelUrl.href)!;
    const appOrigin = new URL(server.resolvedUrls!.local[0]!).origin;
    expect(descriptor.origin).toBe(appOrigin);
    expect(new URL(descriptor.websocket).origin).toBe(appOrigin.replace(/^http/, "ws"));
    panelUrl.hash = "/midi";
    const panel = await browserContext.newPage();
    await panel.goto(panelUrl.href);
    const selector = panel.getByLabel("Application page");
    const playKey = async (index: number): Promise<void> => {
      const key = panel.locator(".key-white").nth(index);
      const bounds = await key.boundingBox();
      if (!bounds) throw new Error("Piano key is not visible");
      await key.click({ position: { x: bounds.width / 2, y: bounds.height - 8 } });
    };
    await panel.waitForFunction(
      (token) => Object.values(localStorage).includes(token),
      descriptor.authToken,
    );
    const a = await browserContext.newPage();
    const b = await browserContext.newPage();
    const url = server.resolvedUrls!.local[0]!;
    await a.goto(url);
    await a.waitForFunction("globalThis.generation === 1");
    await a.waitForFunction("globalThis.devtoolsStatus() === 'connected'");
    await expect
      .poll(
        async () =>
          (await ctx.rpc.sharedState.get<DevPages>("unworklet:pages")).value().pages.length,
      )
      .toBe(1);
    const pages = await ctx.rpc.sharedState.get<DevPages>("unworklet:pages");
    const aId = pages.value().pages[0]!.id;
    await b.goto(url);
    await b.waitForFunction("globalThis.generation === 1");
    await b.waitForFunction("globalThis.devtoolsStatus() === 'connected'");
    await expect.poll(() => pages.value().pages.length).toBe(2);
    const bId = pages.value().pages.find((p) => p.id !== aId)!.id;
    const midi =
      await ctx.rpc.sharedState.get<DevPageSnapshots<DevMidiState>>("unworklet:page-midi");
    const input = (id: string) => midi.value().pages[id]?.ports.find((p) => p.direction === "in");
    await expect.poll(() => input(aId)?.nodeId).toBe("n0");
    await expect.poll(() => input(bId)?.nodeId).toBe("n0");
    const inject = (pageId: string, nodeId: string, note: number) =>
      (
        ctx.rpc.invokeLocal as (
          name: string,
          cmd: Omit<PageMidiInjectCommand, "seq">,
        ) => Promise<void>
      )("unworklet:page-midi-inject", {
        pageId,
        nodeId,
        port: "in",
        event: { type: "noteOn", channel: 0, note, velocity: 100 },
      });
    await selector.selectOption(aId);
    await panel.locator(".fade-leave-active").waitFor({ state: "detached" });
    await expect.poll(() => panel.locator(".inject-routing select").inputValue()).toBe("n0.in");
    await playKey(0);
    await a.waitForFunction("globalThis.received.length === 1");
    expect(await b.evaluate("globalThis.received")).toEqual([]);
    await selector.selectOption(bId);
    await panel.locator(".fade-leave-active").waitFor({ state: "detached" });
    await expect.poll(() => panel.locator(".inject-routing select").inputValue()).toBe("n0.in");
    await playKey(1);
    await b.waitForFunction("globalThis.received.length === 1");
    expect(await a.evaluate("globalThis.received")).toEqual([60]);
    await writeFile(processorPath, source("second"));
    await a.waitForFunction("globalThis.generation === 2");
    await b.waitForFunction("globalThis.generation === 2");
    await expect.poll(() => input(aId)?.nodeId ?? "n0").not.toBe("n0");
    await inject(aId, "n0", 63);
    await selector.selectOption(aId);
    await panel.locator(".fade-leave-active").waitFor({ state: "detached" });
    await expect
      .poll(() => panel.locator(".inject-routing select").inputValue())
      .toBe(input(aId)!.nodeId + ".in");
    await playKey(2);
    await a.waitForFunction("globalThis.received.length === 2");
    expect(await a.evaluate("globalThis.received")).toEqual([60, 64]);
    expect(await b.evaluate("globalThis.received")).toEqual([62]);
    await a.close();
    await expect.poll(() => pages.value().pages.map((p) => p.id), { timeout: 5000 }).toEqual([bId]);
    expect(await selector.inputValue()).toBe(aId);
    await expect.poll(() => panel.locator(".inject-routing select option").count()).toBe(0);
    expect(await panel.locator(".inject-routing select").inputValue()).toBe("");
    await b.reload();
    await b.waitForFunction("globalThis.generation === 1");
    await b.waitForFunction("globalThis.devtoolsStatus() === 'connected'");
    await expect
      .poll(() => pages.value().pages.length === 1 && pages.value().pages[0]!.id !== bId, {
        timeout: 5000,
      })
      .toBe(true);
    const reloadedId = pages.value().pages[0]!.id;
    await expect.poll(() => input(reloadedId)?.nodeId).toBe("n0");
    await inject(bId, "n0", 65);
    expect(await selector.inputValue()).toBe(aId);
    await selector.selectOption(reloadedId);
    await panel.locator(".fade-leave-active").waitFor({ state: "detached" });
    await expect.poll(() => panel.locator(".inject-routing select").inputValue()).toBe("n0.in");
    await playKey(4);
    await b.waitForFunction("globalThis.received.length === 1");
    expect(await b.evaluate("globalThis.received")).toEqual([67]);
    const queue = await ctx.rpc.sharedState.get<PageMidiInject>("unworklet:page-midi-inject");
    expect(queue.value().commands.every((c) => c.pageId === reloadedId)).toBe(true);
    await b.waitForFunction("globalThis.released.includes(67)");
    await b.evaluate("globalThis.captureConnection()");
    const held = await panel.locator(".key-white").nth(5).boundingBox();
    if (!held) throw new Error("Piano key is not visible");
    await panel.mouse.move(held.x + held.width / 2, held.y + held.height - 8);
    await panel.mouse.down();
    await b.waitForFunction("globalThis.received.includes(69)");
    await inject(reloadedId, input(reloadedId)!.nodeId, 69);
    await inject(reloadedId, input(reloadedId)!.nodeId, 69);
    await b.waitForFunction("globalThis.received.filter(note => note === 69).length === 3");
    disconnectPage();
    await b.waitForFunction("globalThis.released.filter(note => note === 69).length === 3");
    await b.waitForFunction("globalThis.devtoolsStatus() === 'disconnected'");
    await expect.poll(() => pages.value().pages.length, { timeout: 5000 }).toBe(0);
    expect(await selector.inputValue()).toBe(reloadedId);
    await panel.mouse.up();
    expect(await b.evaluate("globalThis.released")).toEqual([67, 69, 69, 69]);
    await b.reload();
    await b.waitForFunction("globalThis.generation === 1");
    await b.waitForFunction("globalThis.devtoolsStatus() === 'connected'");
    await expect.poll(() => pages.value().pages.length).toBe(1);
    const recoveredId = pages.value().pages[0]!.id;
    expect(recoveredId).not.toBe(reloadedId);
    await expect.poll(() => input(recoveredId)?.nodeId).toBe("n0");
    await inject(reloadedId, "n0", 70);
    expect(await selector.inputValue()).toBe(reloadedId);
    await selector.selectOption(recoveredId);
    await panel.locator(".fade-leave-active").waitFor({ state: "detached" });
    await expect.poll(() => panel.locator(".inject-routing select").inputValue()).toBe("n0.in");
    await playKey(6);
    await b.waitForFunction("globalThis.received.length === 1");
    expect(await b.evaluate("globalThis.received")).toEqual([71]);
  } finally {
    await browser?.close();
    await closeHmrServer(server);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
