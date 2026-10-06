import { randomFillSync } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { expect, test, vi } from "vite-plus/test";
import * as bridge from "./devbridge.ts";
import unworklet from "./index.ts";

async function pageBridge() {
  const plugin = unworklet();
  const load = plugin.load as (id: string) => Promise<string>;
  return (await load.call({}, "\0unworklet-devbridge"))
    .replace(/^import .*;$/gm, "")
    .replaceAll("import.meta.hot", "hot");
}

function createPage(js: string, failOpen = false, rejectOpen = false) {
  const timers = new Map<number, () => unknown>();
  const calls: Array<{ name: string; arg: any }> = [];
  const sharedKeys: string[] = [];
  let listener: ((value: unknown) => void) | undefined;
  const send = vi.fn();
  const events = new Map<string, (...args: any[]) => void>();
  const windowEvents = new Map<string, () => void>();
  let dispose: (() => void) | undefined;
  const handles = [
    {
      displayName: "synth",
      processorName: "synth",
      node: { node: {}, inputs: {}, outputs: {}, midi: { in: { send } } },
      midiPorts: [{ name: "in", direction: "in" }],
      devDump: async () => ({ slots: [] }),
    },
  ];
  const context = createContext({
    ...bridge,
    crypto: { getRandomValues: randomFillSync },
    document: { title: "Same app" },
    location: new URL("http://localhost:5173/"),
    addEventListener: (name: string, fn: () => void) => windowEvents.set(name, fn),
    removeEventListener: (name: string) => windowEvents.delete(name),
    hot: {
      dispose: (fn: () => void) => {
        dispose = fn;
      },
    },
    AudioNode: class {
      connect() {}
      disconnect() {}
    },
    getDevNodes: () => handles,
    onDevNodesChanged: () => () => {},
    decodeScalar: () => {},
    decodeTypedArray: () => {},
    getDevToolsClientContext: () => ({
      rpc: {
        call: (name: string, arg: unknown) => {
          calls.push({ name, arg: structuredClone(arg) });
          if (name.endsWith("page-open") && failOpen) {
            failOpen = false;
            return Promise.reject(new Error("not ready"));
          }
          if (name.endsWith("page-open") && rejectOpen) {
            rejectOpen = false;
            return Promise.resolve(false);
          }
          return Promise.resolve(true);
        },
        events: {
          on: (name: string, fn: (...args: any[]) => void) => {
            events.set(name, fn);
            return () => events.delete(name);
          },
        },
        sharedState: {
          get: async (key: string) => {
            sharedKeys.push(key);
            return {
              value: () => ({ commands: [] }),
              on: (_: string, cb: typeof listener) => {
                listener = cb;
                return () => {
                  listener = undefined;
                };
              },
            };
          },
        },
      },
    }),
    queueMicrotask,
    setTimeout: (fn: () => unknown, ms: number) => {
      timers.set(ms, fn);
      return ms;
    },
    clearTimeout: (ms: number) => timers.delete(ms),
    console,
  });
  runInContext(js, context);
  return {
    calls,
    sharedKeys,
    send,
    timers,
    context,
    handles,
    events,
    windowEvents,
    dispose: () => dispose!(),
    inject: (commands: unknown[]) => listener?.(structuredClone({ commands })),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("generated bridge isolates two pages whose first MIDI nodes are both n0", async () => {
  const js = await pageBridge();
  const a = createPage(js);
  const b = createPage(js);
  a.handles[0]!.displayName = "Tab A";
  b.handles[0]!.displayName = "Tab B";
  await flush();
  await a.timers.get(150)!();
  await b.timers.get(150)!();
  await flush();
  const graphA = a.calls.find((c) => c.name.endsWith("graph-update"))!.arg;
  const graphB = b.calls.find((c) => c.name.endsWith("graph-update"))!.arg;
  expect(graphA.data.nodes[0].id).toBe("n0");
  expect(graphB.data.nodes[0].id).toBe("n0");
  const commands = [
    {
      seq: 1,
      pageId: graphA.pageId,
      nodeId: "n0",
      port: "in",
      event: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
    },
  ];
  a.inject(commands);
  b.inject(commands);
  expect(a.send).toHaveBeenCalledTimes(1);
  expect(b.send).not.toHaveBeenCalled();
  expect(graphA.pageId).toBeTruthy();
  expect(graphB.pageId).not.toBe(graphA.pageId);
  for (const page of [a, b]) {
    expect(page.sharedKeys).toEqual(["unworklet:page-midi-inject"]);
    await page.timers.get(200)!();
    await page.timers.get(33)!();
    const id = page === a ? graphA.pageId : graphB.pageId;
    for (const kind of ["graph", "state", "signals", "midi"]) {
      expect(
        page.calls.find((c) => c.name === `anonymous:unworklet:page-${kind}-update`)!.arg.pageId,
      ).toBe(id);
      expect(page.calls.some((c) => c.name === `anonymous:unworklet:${kind}-update`)).toBe(false);
    }
  }
});

const note = { type: "noteOn", channel: 0, note: 60, velocity: 100 };
const pageId = (p: ReturnType<typeof createPage>) =>
  p.calls.filter((c) => c.name.endsWith("page-open")).at(-1)!.arg.id;
const injectCommand = (id: string, seq = 1) => ({
  pageId: id,
  seq,
  nodeId: "n0",
  port: "in",
  event: note,
});

for (const lifecycle of ["reconnect", "pagehide"] as const) {
  test(`generated bridge ${lifecycle} rejects stale commands and republishes a fresh page session`, async () => {
    const page = createPage(await pageBridge());
    await flush();
    await page.timers.get(150)!();
    await flush();
    const oldId = pageId(page);
    page.inject([injectCommand(oldId)]);
    expect(page.send).toHaveBeenCalledTimes(1);
    if (lifecycle === "reconnect")
      page.events.get("connection:status")!("disconnected", "connected");
    else page.windowEvents.get("pagehide")!();
    expect(page.send).toHaveBeenLastCalledWith({ ...note, type: "noteOff", velocity: 0 });
    page.inject([injectCommand(oldId, 2)]);
    expect(page.send).toHaveBeenCalledTimes(2);
    if (lifecycle === "reconnect")
      page.events.get("connection:status")!("connected", "disconnected");
    else page.windowEvents.get("pageshow")!();
    await flush();
    await page.timers.get(150)!();
    await flush();
    const nextId = pageId(page);
    expect(nextId).not.toBe(oldId);
    page.inject([injectCommand(oldId, 2), injectCommand(nextId, 3)]);
    page.inject([injectCommand(nextId, 3)]);
    expect(page.send).toHaveBeenCalledTimes(3);
    expect(page.calls.filter((c) => c.name.endsWith("graph-update")).at(-1)!.arg.pageId).toBe(
      nextId,
    );
  });
}

test("generated bridge HMR disposal stops subscriptions, timers and pending telemetry", async () => {
  const page = createPage(await pageBridge());
  await flush();
  await page.timers.get(150)!();
  await flush();
  const id = pageId(page);
  page.dispose();
  const count = page.calls.length;
  page.inject([injectCommand(id)]);
  await flush();
  expect(page.send).not.toHaveBeenCalled();
  expect(page.calls).toHaveLength(count);
  expect(page.timers.size).toBe(0);
  expect(page.events.size).toBe(0);
  expect(page.windowEvents.size).toBe(0);
  expect(page.calls.at(-1)!.name).toBe("anonymous:unworklet:page-close");
});

test("generated bridge retries a transient registration failure without duplicate sessions", async () => {
  const page = createPage(await pageBridge(), true);
  await flush();
  expect(page.calls.filter((c) => c.name.endsWith("graph-update"))).toHaveLength(0);
  await page.timers.get(1000)!();
  await flush();
  await page.timers.get(150)!();
  await flush();
  const id = pageId(page);
  page.inject([injectCommand(id)]);
  expect(page.send).toHaveBeenCalledTimes(1);
  expect(page.calls.filter((c) => c.name.endsWith("page-open"))).toHaveLength(2);
});

test("generated bridge rejects missing page/node/input targets and never mutates queued SysEx bytes", async () => {
  const page = createPage(await pageBridge());
  await flush();
  await page.timers.get(150)!();
  await flush();
  const id = pageId(page);
  const commands = [
    { ...injectCommand(id, 1), pageId: undefined },
    { ...injectCommand(id, 2), pageId: "another-page" },
    { ...injectCommand(id, 3), nodeId: "absent" },
    { ...injectCommand(id, 4), port: "absent" },
    { ...injectCommand(id, 5), event: { type: "sysex", data: [300] } },
    { ...injectCommand(id, 6), event: { type: "sysex", data: [0xf0, 1, 0xf7] } },
  ];
  page.inject(commands);
  expect(page.send).toHaveBeenCalledTimes(1);
  expect(page.send.mock.calls[0]![0].data).toBeInstanceOf(Uint8Array);
  expect((commands[5]!.event as { data: number[] }).data).toEqual([0xf0, 1, 0xf7]);
  page.handles[0]!.midiPorts[0]!.direction = "out";
  page.inject([injectCommand(id, 7)]);
  expect(page.send).toHaveBeenCalledTimes(1);
});

test("generated bridge retries a rejected registration before publishing or injecting", async () => {
  const page = createPage(await pageBridge(), false, true);
  await flush();
  expect(page.calls.filter((c) => c.name.endsWith("graph-update"))).toHaveLength(0);
  expect(page.timers.has(150)).toBe(false);
  await page.timers.get(1000)!();
  await flush();
  await page.timers.get(150)!();
  await flush();
  page.inject([injectCommand(pageId(page))]);
  expect(page.send).toHaveBeenCalledTimes(1);
});

for (const cleanup of ["HMR", "node disposal"] as const) {
  test(`generated bridge ${cleanup} invokes MIDI output subscription cleanup functions`, async () => {
    const page = createPage(await pageBridge());
    const unsubscribe = vi.fn();
    const onEvent = vi.fn(() => unsubscribe);
    Object.assign(page.handles[0]!.node.midi, { out: { onEvent } });
    page.handles[0]!.midiPorts.push({ name: "out", direction: "out" });
    await flush();
    await page.timers.get(150)!();
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(9);
    if (cleanup === "HMR") page.dispose();
    else {
      page.handles.splice(0);
      await page.timers.get(150)!();
    }
    expect(unsubscribe).toHaveBeenCalledTimes(9);
  });
}

test("generated bridge registers on development origins without crypto.randomUUID", async () => {
  const page = createPage(await pageBridge());
  await flush();
  expect(page.calls.some((call) => call.name.endsWith("page-open"))).toBe(true);
  expect(pageId(page)).toMatch(/^[0-9a-f]{32}$/);
  await page.timers.get(150)!();
  await flush();
  page.inject([injectCommand(pageId(page))]);
  expect(page.send).toHaveBeenCalledTimes(1);
});

for (const lifecycle of ["disconnect", "pagehide", "HMR"] as const) {
  test(`generated bridge ${lifecycle} releases held injections on their original ports once`, async () => {
    const page = createPage(await pageBridge());
    const otherSend = vi.fn();
    Object.assign(page.handles[0]!.node.midi, { second: { send: otherSend } });
    page.handles[0]!.midiPorts.push({ name: "second", direction: "in" });
    await flush();
    await page.timers.get(150)!();
    await flush();
    const id = pageId(page);
    page.inject([
      injectCommand(id, 1),
      { ...injectCommand(id, 2), event: { ...note, channel: 4, note: 63 } },
      { ...injectCommand(id, 3), port: "second", event: { ...note, note: 65 } },
    ]);
    const replacement = vi.fn();
    page.handles[0]!.node.midi.in = { send: replacement };
    const end = () => {
      if (lifecycle === "disconnect") page.events.get("connection:status")!("disconnected");
      else if (lifecycle === "pagehide") page.windowEvents.get("pagehide")!();
      else page.dispose();
    };
    end();
    if (lifecycle !== "HMR") end();
    expect(page.send.mock.calls.slice(2)).toEqual([
      [{ ...note, type: "noteOff", velocity: 0 }],
      [{ ...note, type: "noteOff", velocity: 0, channel: 4, note: 63 }],
    ]);
    expect(otherSend.mock.calls.slice(1)).toEqual([
      [{ ...note, type: "noteOff", velocity: 0, note: 65 }],
    ]);
    expect(replacement).not.toHaveBeenCalled();
  });
}

test("generated bridge cleanup releases only held notes and continues after a port send fails", async () => {
  const page = createPage(await pageBridge());
  await flush();
  await page.timers.get(150)!();
  await flush();
  const id = pageId(page);
  let seq = 0;
  const send = (event: object) => page.inject([{ ...injectCommand(id, ++seq), event }]);
  send(note);
  send({ ...note, type: "noteOff", velocity: 0 });
  send({ ...note, note: 61 });
  send({ ...note, note: 61, velocity: 0 });
  send({ ...note, note: 62 });
  send({ type: "cc", channel: 0, controller: 123, value: 0 });
  send({ ...note, channel: 1, note: 63 });
  send({ type: "cc", channel: 1, controller: 120, value: 0 });
  page.send.mockImplementationOnce(() => {
    throw new Error("send failed");
  });
  send({ ...note, note: 64 });
  send({ ...note, note: 65 });
  send({ ...note, channel: 2, note: 66 });
  send({ type: "cc", channel: 3, controller: 123, value: 0 });
  send({ type: "cc", channel: 0, controller: 1, value: 64 });
  send({ ...note, note: 67 });
  page.send.mockImplementationOnce(() => {
    throw new Error("noteOff failed");
  });
  send({ ...note, type: "noteOff", note: 67, velocity: 0 });
  page.send.mockClear();
  page.send.mockImplementationOnce(() => {
    throw new Error("port closed");
  });
  page.events.get("connection:status")!("disconnected");
  expect(page.send.mock.calls).toEqual([
    [{ ...note, type: "noteOff", velocity: 0, note: 65 }],
    [{ ...note, type: "noteOff", velocity: 0, channel: 2, note: 66 }],
    [{ ...note, type: "noteOff", velocity: 0, note: 67 }],
  ]);
  page.events.get("connection:status")!("disconnected");
  expect(page.send).toHaveBeenCalledTimes(4);
  expect(page.send).toHaveBeenLastCalledWith({ ...note, type: "noteOff", velocity: 0, note: 65 });
});

test("generated bridge releases a replaced input through the retired port and drops its tracking", async () => {
  const page = createPage(await pageBridge());
  await flush();
  await page.timers.get(150)!();
  await flush();
  page.inject([injectCommand(pageId(page))]);
  const replacement = vi.fn();
  page.handles[0]!.node.midi.in = { send: replacement };
  await page.timers.get(150)!();
  expect(page.send).toHaveBeenLastCalledWith({ ...note, type: "noteOff", velocity: 0 });
  page.dispose();
  expect(page.send).toHaveBeenCalledTimes(2);
  expect(replacement).not.toHaveBeenCalled();
});

test("generated bridge balances repeated noteOn injections with one release per unmatched send", async () => {
  const page = createPage(await pageBridge());
  await flush();
  await page.timers.get(150)!();
  await flush();
  const id = pageId(page);
  let seq = 0;
  const send = (event: object) => page.inject([{ ...injectCommand(id, ++seq), event }]);
  send(note);
  send(note);
  send(note);
  send({ ...note, type: "noteOff", velocity: 0 });
  send({ ...note, note: 61 });
  send({ ...note, note: 61 });
  send({ ...note, note: 61, velocity: 0 });
  for (const channel of [4, 5]) {
    send({ ...note, channel });
    send({ ...note, channel });
    send({ type: "cc", channel, controller: channel === 4 ? 123 : 120, value: 0 });
  }
  send({ ...note, note: 65 });
  send({ ...note, note: 65 });
  page.send.mockImplementationOnce(() => {
    throw new Error("noteOff failed");
  });
  send({ ...note, note: 65, type: "noteOff", velocity: 0 });
  page.send.mockClear();
  page.events.get("connection:status")!("disconnected");
  page.events.get("connection:status")!("disconnected");
  expect(page.send.mock.calls).toEqual([
    [{ ...note, type: "noteOff", velocity: 0 }],
    [{ ...note, type: "noteOff", velocity: 0 }],
    [{ ...note, type: "noteOff", velocity: 0, note: 61 }],
    [{ ...note, type: "noteOff", velocity: 0, note: 65 }],
    [{ ...note, type: "noteOff", velocity: 0, note: 65 }],
  ]);
});
