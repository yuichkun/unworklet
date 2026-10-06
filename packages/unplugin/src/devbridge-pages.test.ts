import { randomFillSync } from "node:crypto";
import { audioOutput, defineProcessor, event, forSample, select, state } from "@unworklet/core";
import { renderOffline } from "../../offline/src/index.ts";
import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { createContext, runInContext } from "node:vm";
import { expect, test, vi } from "vite-plus/test";
import * as bridge from "./devbridge.ts";
import unworklet from "./index.ts";
import { setupDevtoolsPages } from "./devtools-pages.ts";

async function pageBridge() {
  const plugin = unworklet();
  const load = plugin.load as (id: string) => Promise<string>;
  return (await load.call({}, "\0unworklet-devbridge"))
    .replace(/^import .*;$/gm, "")
    .replaceAll("import.meta.hot", "hot");
}

type TestTransport = {
  call: (name: string, arg: unknown) => unknown;
  states: Map<string, ReturnType<typeof createSharedState<any>>>;
};

function createPage(js: string, failOpen = false, rejectOpen = false, transport?: TestTransport) {
  const timers = new Map<number, () => unknown>();
  const calls: Array<{ name: string; arg: any }> = [];
  const sharedKeys: string[] = [];
  const listeners = new Map<string, (value: unknown) => void>();
  const queues = new Map<string, { commands: unknown[] }>();
  const injectQueue = (key: string, commands: unknown[]) => {
    const value = structuredClone({ commands });
    queues.set(key, value);
    listeners.get(key)?.(value);
  };
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
          return Promise.resolve(transport ? transport.call(name, structuredClone(arg)) : true);
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
            if (transport) {
              const shared = transport.states.get(key)!;
              return {
                value: () => structuredClone(shared.value()),
                on: (_: string, cb: (value: unknown) => void) =>
                  shared.on("updated", (value: unknown) => cb(structuredClone(value))),
              };
            }
            return {
              value: () => structuredClone(queues.get(key) ?? { commands: [] }),
              on: (_: string, cb: (value: unknown) => void) => {
                listeners.set(key, cb);
                return () => listeners.delete(key);
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
    inject: (commands: unknown[]) => injectQueue("unworklet:page-midi-inject", commands),
    injectRaw: (commands: unknown[]) => injectQueue("unworklet:midi-inject", commands),
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
    expect(page.sharedKeys).toEqual(["unworklet:page-midi-inject", "unworklet:midi-inject"]);
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

test("custom unscoped consumers and generated scoped bridges deliver once without crossing queues", async () => {
  const states = new Map<string, ReturnType<typeof createSharedState<any>>>();
  const handlers = new Map<string, (arg: any) => unknown>();
  const peers = new Set<any>();
  const a = { peer: { peers } };
  const b = { peer: { peers } };
  peers.add(a.peer);
  peers.add(b.peer);
  let session = a;
  const dispose = await setupDevtoolsPages({
    rpc: {
      getCurrentRpcSession: () => ({ meta: session }),
      sharedState: {
        get: async (key: string, options: { initialValue: object }) => {
          const state = createSharedState({ initialValue: options.initialValue });
          states.set(key, state);
          return state;
        },
      },
      register: (definition: { name: string; setup: () => { handler: (arg: any) => unknown } }) =>
        handlers.set(definition.name, definition.setup().handler),
    },
  } as any);
  const call = (name: string, arg: unknown) => handlers.get(name)!(structuredClone(arg));
  let publishMidi = false;
  const transport = (owner: typeof a): TestTransport => ({
    states,
    call: (name, arg) => {
      session = owner;
      if (!publishMidi && name.endsWith("page-midi-update")) return;
      return call(name, arg);
    },
  });
  const raw = states.get("unworklet:midi-inject")!;
  const customSend = vi.fn();
  let customSeq = 0;
  const offCustom = raw.on("updated", (value: any) => {
    for (const command of value.commands) {
      if (command.seq <= customSeq) continue;
      customSeq = command.seq;
      customSend(command.event);
    }
  });
  const command = { nodeId: "n0", port: "in", event: note };
  const pages: Array<ReturnType<typeof createPage>> = [];
  try {
    call("unworklet:midi-inject", command);
    expect(customSend).toHaveBeenCalledTimes(1);
    const js = await pageBridge();
    const first = createPage(js, false, false, transport(a));
    const second = createPage(js, false, false, transport(b));
    pages.push(first, second);
    await flush();
    for (const page of pages) await page.timers.get(150)!();
    await flush();
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(states.get("unworklet:page-midi")!.value().pages).toEqual({});
    call("unworklet:midi-inject", command);
    expect(customSend).toHaveBeenCalledTimes(2);
    expect(first.send).toHaveBeenCalledTimes(2);
    expect(second.send).toHaveBeenCalledTimes(2);
    publishMidi = true;
    for (const page of pages) await page.timers.get(150)!();
    await flush();
    call("unworklet:page-midi-inject", { ...command, pageId: pageId(first) });
    expect(customSend).toHaveBeenCalledTimes(2);
    expect(first.send).toHaveBeenCalledTimes(3);
    expect(second.send).toHaveBeenCalledTimes(2);
    const oldId = pageId(first);
    first.events.get("connection:status")!("disconnected");
    first.events.get("connection:status")!("connected");
    await flush();
    await first.timers.get(150)!();
    await flush();
    expect(pageId(first)).not.toBe(oldId);
    expect(first.send.mock.calls.slice(3)).toEqual([
      [{ ...note, type: "noteOff", velocity: 0 }],
      [{ ...note, type: "noteOff", velocity: 0 }],
      [{ ...note, type: "noteOff", velocity: 0 }],
    ]);
    call("unworklet:page-midi-inject", { ...command, pageId: oldId });
    expect(first.send).toHaveBeenCalledTimes(6);
    expect(second.send).toHaveBeenCalledTimes(2);
    expect(customSend).toHaveBeenCalledTimes(2);
    expect(raw.value().commands).toHaveLength(2);
  } finally {
    for (const page of pages) page.dispose();
    offCustom();
    dispose();
  }
});

test("raw queue advances past missing local targets and retains its cursor across reconnect", async () => {
  const page = createPage(await pageBridge());
  const handles = page.handles.splice(0);
  const command = { seq: 1, nodeId: "n0", port: "in", event: note };
  page.injectRaw([command]);
  await flush();
  await page.timers.get(150)!();
  await flush();
  page.handles.push(...handles);
  await page.timers.get(150)!();
  await flush();
  expect(page.send).not.toHaveBeenCalled();
  page.injectRaw([command, { ...command, seq: 2 }]);
  expect(page.send).toHaveBeenCalledTimes(1);
  const oldId = pageId(page);
  page.events.get("connection:status")!("disconnected");
  expect(page.send).toHaveBeenCalledTimes(2);
  page.injectRaw([command, { ...command, seq: 2 }, { ...command, seq: 3 }]);
  page.inject([injectCommand(oldId)]);
  expect(page.send).toHaveBeenCalledTimes(2);
  page.events.get("connection:status")!("connected");
  await flush();
  await page.timers.get(150)!();
  await flush();
  expect(page.send).toHaveBeenCalledTimes(3);
  expect(page.send).toHaveBeenLastCalledWith(note);
  page.injectRaw([command, { ...command, seq: 2 }, { ...command, seq: 3 }]);
  expect(page.send).toHaveBeenCalledTimes(3);
  page.dispose();
  page.injectRaw([{ ...command, seq: 4 }]);
  expect(page.send).toHaveBeenCalledTimes(4);
});

test("a fresh bridge consumes retained raw commands but never another page's scoped commands", async () => {
  const js = await pageBridge();
  const first = createPage(js);
  const second = createPage(js);
  const command = { seq: 1, nodeId: "n0", port: "in", event: note };
  await flush();
  const scoped = injectCommand(pageId(first));
  for (const page of [first, second]) {
    page.injectRaw([command]);
    page.inject([scoped]);
    await page.timers.get(150)!();
  }
  await flush();
  expect(first.send).toHaveBeenCalledTimes(2);
  expect(second.send).toHaveBeenCalledTimes(1);
  const third = createPage(js);
  third.injectRaw([command]);
  third.inject([scoped]);
  await flush();
  await third.timers.get(150)!();
  await flush();
  expect(third.send).toHaveBeenCalledExactlyOnceWith(note);
  for (const page of [first, second, third]) page.dispose();
});

function sustainConsumer() {
  const down = new Set<string>();
  const sounding = new Set<string>();
  const pedals = new Set<string>();
  const captured = new Set<string>();
  const held = (key: string) => {
    const channel = key.split(":")[0];
    return (
      pedals.has(`${channel}:64`) ||
      pedals.has(`${channel}:69`) ||
      (pedals.has(`${channel}:66`) && captured.has(key))
    );
  };
  const send = vi.fn((event: any) => {
    const key = `${event.channel}:${event.note}`;
    if (event.type === "noteOn" && event.velocity > 0) {
      down.add(key);
      sounding.add(key);
    } else if (event.type === "noteOff" || (event.type === "noteOn" && event.velocity === 0)) {
      down.delete(key);
      if (!held(key)) sounding.delete(key);
    } else if (
      event.type === "cc" &&
      ([64, 66, 69].includes(event.controller) || event.controller === 121)
    ) {
      const pedal = `${event.channel}:${event.controller}`;
      if (event.controller !== 121 && event.value >= 64) {
        if (event.controller === 66 && !pedals.has(pedal)) {
          for (const note of sounding) if (note.startsWith(`${event.channel}:`)) captured.add(note);
        }
        pedals.add(pedal);
      } else {
        if (event.controller === 121) {
          for (const pedal of pedals)
            if (pedal.startsWith(`${event.channel}:`)) pedals.delete(pedal);
        } else pedals.delete(pedal);
        if (event.controller === 66 || event.controller === 121)
          for (const note of captured)
            if (note.startsWith(`${event.channel}:`)) captured.delete(note);
        for (const note of sounding)
          if (note.startsWith(`${event.channel}:`) && !down.has(note) && !held(note))
            sounding.delete(note);
      }
    }
  });
  return { send, sounding };
}

for (const controller of [64, 66, 69]) {
  for (const lifecycle of ["disconnect", "pagehide", "HMR", "retired input"] as const) {
    test(`generated bridge ${lifecycle} releases CC${controller} after the key was already released`, async () => {
      const page = createPage(await pageBridge());
      const synth = sustainConsumer();
      page.handles[0]!.node.midi.in = { send: synth.send };
      await flush();
      await page.timers.get(150)!();
      await flush();
      const id = pageId(page);
      page.inject([
        injectCommand(id, 1),
        { ...injectCommand(id, 2), event: { type: "cc", channel: 0, controller, value: 64 } },
        { ...injectCommand(id, 3), event: { ...note, type: "noteOff", velocity: 0 } },
      ]);
      expect([...synth.sounding]).toEqual(["0:60"]);
      if (lifecycle === "disconnect") page.events.get("connection:status")!("disconnected");
      else if (lifecycle === "pagehide") page.windowEvents.get("pagehide")!();
      else if (lifecycle === "HMR") page.dispose();
      else {
        page.handles.splice(0);
        await page.timers.get(150)!();
      }
      expect([...synth.sounding]).toEqual([]);
      expect(synth.send).toHaveBeenLastCalledWith({
        type: "cc",
        channel: 0,
        controller,
        value: 0,
      });
    });
  }
}

test("sustain cleanup respects thresholds, repeated changes, failed sends and exact port/channel ownership", async () => {
  const page = createPage(await pageBridge());
  const first = sustainConsumer();
  const second = sustainConsumer();
  page.handles[0]!.node.midi.in = { send: first.send };
  Object.assign(page.handles[0]!.node.midi, { second: { send: second.send } });
  page.handles[0]!.midiPorts.push({ name: "second", direction: "in" });
  await flush();
  await page.timers.get(150)!();
  await flush();
  let seq = 0;
  const send = (event: object, port = "in") =>
    page.inject([{ ...injectCommand(pageId(page), ++seq), port, event }]);
  const pedal = (channel: number, value: number) => ({
    type: "cc",
    channel,
    controller: 64,
    value,
  });
  send(note);
  send(pedal(0, 64));
  send(pedal(0, 127));
  send({ ...note, type: "noteOff", velocity: 0 });
  first.send.mockImplementationOnce(() => {
    throw new Error("pedal release failed");
  });
  send(pedal(0, 0));
  send(pedal(1, 64));
  send(pedal(1, 63));
  send(pedal(2, 127));
  send({ type: "cc", channel: 2, controller: 121, value: 0 });
  first.send.mockImplementationOnce(() => {
    throw new Error("pedal down failed");
  });
  send(pedal(3, 127));
  send({ ...note, channel: 4 }, "second");
  send(pedal(4, 127), "second");
  send({ ...note, channel: 4, type: "noteOff", velocity: 0 }, "second");
  second.send({ ...note, channel: 5 });
  second.send(pedal(5, 127));
  second.send({ ...note, channel: 5, type: "noteOff", velocity: 0 });
  expect([...first.sounding]).toEqual(["0:60"]);
  expect([...second.sounding]).toEqual(["4:60", "5:60"]);
  first.send.mockClear();
  second.send.mockClear();
  first.send.mockImplementationOnce(() => {
    throw new Error("cleanup release failed");
  });
  page.events.get("connection:status")!("disconnected");
  expect([...first.sounding]).toEqual(["0:60"]);
  expect([...second.sounding]).toEqual(["5:60"]);
  page.events.get("connection:status")!("disconnected");
  expect([...first.sounding]).toEqual([]);
  expect(first.send.mock.calls).toEqual([[pedal(0, 0)], [pedal(0, 0)]]);
  expect(second.send.mock.calls).toEqual([[pedal(4, 0)]]);
});

test.each([[64], [66], [69], [64, 66, 69]].map((controllers) => ({ controllers })))(
  "session cleanup silences rendered PCM held by $controllers after noteOff",
  async ({ controllers }) => {
    const processor = defineProcessor(() => {
      const keys = event.midi({ from: "main", name: "keys" });
      const out = audioOutput({ channels: 1, name: "audio" });
      const pedals = controllers.map(() => state.bool(false));
      const held = () => pedals.map((pedal) => pedal.read()).reduce((a, b) => a.or(b));
      const keyDown = state.bool(false);
      const sounding = state.bool(false);
      return {
        process: () => {
          keys.onEvent("noteOn", () => {
            keyDown.write(true);
            sounding.write(true);
          });
          keys.onEvent("noteOff", () => {
            keyDown.write(false);
            sounding.write(held());
          });
          keys.onEvent("cc", ({ controller, value }) => {
            for (const [i, number] of controllers.entries())
              pedals[i]!.write(select(controller.eq(number), value.gte(64), pedals[i]!.read()));
            sounding.write(select(held().not().and(keyDown.read().not()), false, sounding.read()));
          });
          forSample((i) =>
            out
              .ch(0)
              .at(i)
              .write(select(sounding.read(), 0.125, 0)),
          );
        },
      };
    });
    const page = createPage(await pageBridge());
    await flush();
    await page.timers.get(150)!();
    await flush();
    const id = pageId(page);
    page.inject([
      injectCommand(id, 1),
      ...controllers.map((controller, i) => ({
        ...injectCommand(id, i + 2),
        event: { type: "cc", channel: 0, controller, value: 127 },
      })),
      {
        ...injectCommand(id, controllers.length + 2),
        event: { ...note, type: "noteOff", velocity: 0 },
      },
    ]);
    const render = async () =>
      (
        await renderOffline(processor, {
          sampleRate: 48000,
          duration: 128 / 48000,
          events: page.send.mock.calls.map(([payload]) => ({ name: "keys", atSample: 0, payload })),
        })
      ).outputs.audio![0]!;
    expect([...new Set(await render())]).toEqual([0.125]);
    page.events.get("connection:status")!("disconnected");
    expect([...new Set(await render())]).toEqual([0]);
  },
);

test("Sostenuto captures notes sounding before engagement without recapturing later notes", async () => {
  const page = createPage(await pageBridge());
  const synth = sustainConsumer();
  page.handles[0]!.node.midi.in = { send: synth.send };
  await flush();
  await page.timers.get(150)!();
  await flush();
  const id = pageId(page);
  page.inject([
    injectCommand(id, 1),
    { ...injectCommand(id, 2), event: { type: "cc", channel: 0, controller: 66, value: 64 } },
    { ...injectCommand(id, 3), event: { ...note, note: 62 } },
    { ...injectCommand(id, 4), event: { type: "cc", channel: 0, controller: 66, value: 127 } },
    { ...injectCommand(id, 5), event: { ...note, type: "noteOff", velocity: 0 } },
    { ...injectCommand(id, 6), event: { ...note, note: 62, type: "noteOff", velocity: 0 } },
  ]);
  expect([...synth.sounding]).toEqual(["0:60"]);
  page.events.get("connection:status")!("disconnected");
  expect([...synth.sounding]).toEqual([]);
});

test("combined holding pedals release independently and CC121 clears only its channel", async () => {
  const page = createPage(await pageBridge());
  const synth = sustainConsumer();
  page.handles[0]!.node.midi.in = { send: synth.send };
  await flush();
  await page.timers.get(150)!();
  await flush();
  let seq = 0;
  const send = (event: object) => page.inject([{ ...injectCommand(pageId(page), ++seq), event }]);
  for (const channel of [0, 1]) {
    send({ ...note, channel });
    for (const controller of [64, 66, 69]) send({ type: "cc", channel, controller, value: 127 });
    send({ ...note, channel, type: "noteOff", velocity: 0 });
  }
  send({ type: "cc", channel: 0, controller: 64, value: 63 });
  send({ type: "cc", channel: 1, controller: 121, value: 0 });
  expect([...synth.sounding]).toEqual(["0:60"]);
  synth.send.mockClear();
  page.dispose();
  expect([...synth.sounding]).toEqual([]);
  expect(synth.send.mock.calls).toEqual(
    [66, 69].map((controller) => [{ type: "cc", channel: 0, controller, value: 0 }]),
  );
});
