import { createSharedState } from "@vitejs/devtools-kit/utils/shared-state";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { setupDevtoolsPages } from "./devtools-pages.ts";

afterEach(() => vi.useRealTimers());

async function server() {
  const states = new Map<string, ReturnType<typeof createSharedState<any>>>();
  const handlers = new Map<string, (arg: any) => Promise<unknown>>();
  const peers = new Set<any>();
  const a = { id: 1, peer: { peers } };
  const b = { id: 2, peer: { peers } };
  peers.add(a.peer);
  peers.add(b.peer);
  let session: typeof a | null = a;
  const ctx = {
    rpc: {
      getCurrentRpcSession: () => (session ? { meta: session } : undefined),
      sharedState: {
        get: async (key: string, opts: { initialValue: object }) => {
          const state = createSharedState({ initialValue: opts.initialValue });
          states.set(key, state);
          return state;
        },
      },
      register: (def: { name: string; setup: () => { handler: (arg: any) => Promise<unknown> } }) =>
        handlers.set(def.name, def.setup().handler),
    },
  };
  const dispose = await setupDevtoolsPages(ctx as any);
  const call = (name: string, arg: unknown, from: typeof a | null = a) => {
    session = from;
    return handlers.get(name.startsWith("unworklet:") ? name : `anonymous:unworklet:${name}`)!(
      structuredClone(arg),
    );
  };
  const read = (key: string) =>
    states.get(`unworklet:${key === "pages" ? key : "page-" + key}`)!.value();
  const raw = (key: string) => states.get(`unworklet:${key}`)!.value();
  return { a, b, peers, call, read, raw, dispose };
}
const page = (id: string) => ({ id, title: "Same app", url: "http://localhost:5173/" });
const midi = {
  ports: [{ nodeId: "n0", node: "synth", name: "in", direction: "in", overflow: 0 }],
  log: [],
};
const command = (pageId: string) => ({
  pageId,
  nodeId: "n0",
  port: "in",
  event: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
});

test("all telemetry keeps separate snapshots for same node IDs and rejects another session's writes", async () => {
  const s = await server();
  try {
    await s.call("page-open", page("a"), s.a);
    await s.call("page-open", page("b"), s.b);
    for (const kind of ["graph", "state", "signals", "midi"]) {
      await s.call(`page-${kind}-update`, { pageId: "a", data: { marker: "A" } }, s.a);
      await s.call(`page-${kind}-update`, { pageId: "b", data: { marker: "B" } }, s.b);
      await s.call(`page-${kind}-update`, { pageId: "a", data: { marker: "wrong" } }, s.b);
      await s.call(`page-${kind}-update`, { pageId: "unknown", data: {} }, s.a);
      expect(s.read(kind)).toEqual({ pages: { a: { marker: "A" }, b: { marker: "B" } } });
    }
    await s.call("page-open", { ...page("a"), title: "Hijack" }, s.b);
    expect(s.read("pages").pages.map((p: any) => p.title)).toEqual(["Same app", "Same app"]);
  } finally {
    s.dispose();
  }
});

test("injection requires the selected live page and declared input; closing only clears that page", async () => {
  const s = await server();
  try {
    await s.call("page-open", page("a"), s.a);
    await s.call("page-open", page("b"), s.b);
    await s.call("page-midi-update", { pageId: "a", data: midi }, s.a);
    await s.call("page-midi-update", { pageId: "b", data: midi }, s.b);
    await s.call("unworklet:page-midi-inject", command("a"));
    await s.call("unworklet:page-midi-inject", command("b"));
    await s.call("unworklet:page-midi-inject", command("missing"));
    await s.call("unworklet:page-midi-inject", { ...command("a"), nodeId: "missing" });
    await s.call("unworklet:page-midi-inject", { ...command("a"), port: "missing" });
    expect(s.read("midi-inject").commands.map((c: any) => c.pageId)).toEqual(["a", "b"]);
    await s.call("page-close", { pageId: "a" }, s.b);
    expect(s.read("pages").pages).toHaveLength(2);
    await s.call("page-close", { pageId: "a" }, s.a);
    await s.call("unworklet:page-midi-inject", command("a"));
    expect(s.read("pages").pages).toEqual([page("b")]);
    expect(s.read("midi")).toEqual({ pages: { b: midi } });
    expect(s.read("midi-inject").commands.map((c: any) => c.pageId)).toEqual(["b"]);
    await s.call("page-state-update", { pageId: "a", data: { nodes: ["late"] } }, s.a);
    expect(s.read("state").pages.a).toBeUndefined();
  } finally {
    s.dispose();
  }
});

test("peer disconnect cleans snapshots and commands without expiring connected background pages", async () => {
  vi.useFakeTimers();
  const s = await server();
  try {
    await s.call("page-open", page("a"), s.a);
    await s.call("page-open", page("b"), s.b);
    await s.call("page-midi-update", { pageId: "a", data: midi }, s.a);
    await s.call("unworklet:page-midi-inject", command("a"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(s.read("pages").pages).toHaveLength(2);
    s.peers.delete(s.a.peer);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.read("pages").pages).toEqual([page("b")]);
    expect(s.read("midi").pages.a).toBeUndefined();
    expect(s.read("midi-inject").commands).toEqual([]);
    s.peers.delete(s.b.peer);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    s.dispose();
  }
});

test("registration rejects invalid or disconnected senders and replaces only the same session's page", async () => {
  const s = await server();
  try {
    await s.call("page-open", page("none"), null);
    await s.call("page-open", page("no-peer"), { ...s.a, peer: undefined } as never);
    await s.call("page-open", page("__proto__"));
    await s.call("page-open", { title: "Missing ID", url: "http://localhost/" });
    s.peers.delete(s.a.peer);
    await s.call("page-open", page("closed"));
    expect(s.read("pages").pages).toEqual([]);
    s.peers.add(s.a.peer);
    await s.call("page-open", page("first"));
    await s.call("page-open", page("other"), s.b);
    await s.call("unworklet:page-midi-inject", command("first"));
    expect(s.read("midi-inject").commands).toEqual([]);
    await s.call("page-midi-update", {
      pageId: "first",
      data: { ports: [{ ...midi.ports[0], direction: "out" }], log: [] },
    });
    await s.call("unworklet:page-midi-inject", command("first"));
    expect(s.read("midi-inject").commands).toEqual([]);
    await s.call("page-open", page("replacement"));
    expect(s.read("pages").pages).toEqual([page("other"), page("replacement")]);
    expect(s.read("midi").pages.first).toBeUndefined();
    await s.call("page-midi-update", { pageId: "replacement", data: midi });
    await s.call("page-close", { pageId: "replacement" }, null);
    expect(s.read("pages").pages).toHaveLength(2);
    s.peers.delete(s.a.peer);
    await s.call("unworklet:page-midi-inject", command("replacement"));
    expect(s.read("midi-inject").commands).toEqual([]);
  } finally {
    s.dispose();
  }
});

test("RPC payloads remain independent after wire cloning and injection stays bounded", async () => {
  const s = await server();
  try {
    const metadata = page("a");
    await s.call("page-open", metadata);
    metadata.title = "Local mutation";
    const snapshot = structuredClone(midi);
    await s.call("page-midi-update", { pageId: "a", data: snapshot });
    snapshot.ports[0]!.name = "Changed locally";
    expect(s.read("pages").pages[0].title).toBe("Same app");
    expect(s.read("midi").pages.a.ports[0].name).toBe("in");
    for (let i = 0; i < 70; i++) await s.call("unworklet:page-midi-inject", command("a"));
    expect(s.read("midi-inject").commands).toHaveLength(64);
    expect(s.read("midi-inject").commands[0].seq).toBe(7);
  } finally {
    s.dispose();
  }
});

test("server disposal clears page data and prevents late registrations", async () => {
  const s = await server();
  await s.call("page-open", page("a"));
  await s.call("page-midi-update", { pageId: "a", data: midi });
  await s.call("unworklet:page-midi-inject", command("a"));
  s.dispose();
  await s.call("page-open", page("late"));
  expect(s.read("pages").pages).toEqual([]);
  expect(s.read("midi").pages).toEqual({});
  expect(s.read("midi-inject").commands).toEqual([]);
});

test("registration reports acceptance so a page never publishes into a rejected session", async () => {
  const s = await server();
  try {
    expect(await s.call("page-open", page("a"))).toBe(true);
    expect(await s.call("page-open", page("a"), s.b)).toBe(false);
    expect(await s.call("page-open", page("closed"), null)).toBe(false);
  } finally {
    s.dispose();
  }
});

const snapshots = () => ({
  graph: {
    nodes: [{ id: "n0", label: "Synth", kind: "unworklet", audioNodeType: "AudioWorkletNode" }],
    edges: [],
  },
  state: { nodes: [{ id: "n0", displayName: "Synth", scalars: [], buffers: [] }] },
  signals: {
    nodes: [{ id: "n0", displayName: "Synth", ports: [], memory: [], memoryBytes: 0 }],
    context: { sampleRate: 48000, baseLatencyMs: 2, outputLatencyMs: 3 },
  },
  midi: structuredClone(midi),
});

test("unscoped keys and update RPCs preserve raw latest-snapshot compatibility", async () => {
  const s = await server();
  try {
    expect(s.raw("graph")).toEqual({ nodes: [], edges: [] });
    expect(s.raw("state")).toEqual({ nodes: [] });
    expect(s.raw("signals")).toEqual({
      nodes: [],
      context: { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 },
    });
    expect(s.raw("midi")).toEqual({ ports: [], log: [] });
    expect(s.raw("midi-inject")).toEqual({ commands: [] });
    await s.call("page-open", page("a"), s.a);
    await s.call("page-open", page("b"), s.b);
    for (const [kind, value] of Object.entries(snapshots())) {
      await s.call(`page-${kind}-update`, { pageId: "a", data: value }, s.a);
      expect(s.raw(kind)).toEqual(value);
      const next = kind === "midi" ? { ports: [], log: [] } : { ...value, nodes: [] };
      await s.call(`page-${kind}-update`, { pageId: "b", data: next }, s.b);
      expect(s.raw(kind)).toEqual(next);
      await s.call(`${kind}-update`, value);
      expect(s.raw(kind)).toEqual(value);
      expect(s.read(kind).pages.b).toEqual(next);
      await s.call(`page-${kind}-update`, { pageId: "a", data: next }, s.b);
      expect(s.raw(kind)).toEqual(value);
    }
    await s.call("page-close", { pageId: "a" }, s.a);
    await s.call("page-close", { pageId: "b" }, s.b);
    for (const [kind, value] of Object.entries(snapshots())) {
      expect(s.raw(kind)).toEqual(value);
      expect(s.read(kind)).toEqual({ pages: {} });
    }
  } finally {
    s.dispose();
  }
});

test("unscoped MIDI preserves raw publication and broadcasts only its own calls to live pages", async () => {
  const s = await server();
  const cmd = { nodeId: "n0", port: "in", event: command("a").event };
  try {
    await s.call("unworklet:midi-inject", cmd);
    expect(s.raw("midi-inject").commands).toEqual([{ ...cmd, seq: 1 }]);
    expect(s.read("midi-inject").commands).toEqual([]);
    await s.call("page-open", page("a"), s.a);
    await s.call("page-midi-update", { pageId: "a", data: midi }, s.a);
    expect(s.read("midi-inject").commands).toEqual([]);
    await s.call("unworklet:midi-inject", { ...cmd, port: "missing" });
    expect(s.raw("midi-inject").commands).toHaveLength(2);
    expect(s.read("midi-inject").commands).toEqual([]);
    await s.call("unworklet:midi-inject", cmd);
    expect(s.raw("midi-inject").commands.at(-1)).toEqual({ ...cmd, seq: 3 });
    expect(s.read("midi-inject").commands).toEqual([{ ...cmd, seq: 1, pageId: "a" }]);
    await s.call("page-open", page("b"), s.b);
    await s.call("page-midi-update", { pageId: "b", data: midi }, s.b);
    expect(s.raw("midi-inject").commands).toHaveLength(3);
    await s.call("unworklet:page-midi-inject", command("a"));
    expect(s.raw("midi-inject").commands).toHaveLength(3);
    expect(s.read("midi-inject").commands.map((c: any) => c.pageId)).toEqual(["a", "a"]);
    await s.call("unworklet:midi-inject", cmd);
    expect(s.raw("midi-inject").commands.at(-1)).toEqual({ ...cmd, seq: 4 });
    expect(s.read("midi-inject").commands.map((c: any) => c.pageId)).toEqual(["a", "a", "a", "b"]);
    s.peers.delete(s.a.peer);
    await s.call("unworklet:midi-inject", cmd);
    expect(s.read("midi-inject").commands.at(-1).pageId).toBe("b");
    for (let i = 0; i < 70; i++) await s.call("unworklet:midi-inject", cmd);
    expect(s.raw("midi-inject").commands).toHaveLength(64);
    await s.call("page-close", { pageId: "b" }, s.b);
    expect(s.raw("midi-inject").commands).toHaveLength(64);
    s.peers.add(s.a.peer);
    await s.call("page-open", page("fresh"), s.a);
    await s.call("page-midi-update", { pageId: "fresh", data: midi }, s.a);
    expect(s.read("midi-inject").commands).toEqual([]);
    expect(s.raw("midi-inject").commands).toHaveLength(64);
  } finally {
    s.dispose();
  }
});
