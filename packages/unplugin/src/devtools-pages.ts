import type { ViteDevToolsNodeContext } from "@vitejs/devtools-kit";
import type {
  DevAudioGraph,
  DevLiveState,
  DevMidiInject,
  DevMidiInjectCommand,
  DevMidiState,
  DevSignalsState,
} from "./index.ts";

/**
 * Devframe's untrusted-RPC scope prefix. Every method name registered or called
 * from an untrusted client (the page-side devbridge) must start with this string
 * or the anonymous-method gate rejects it (DTK0013), silently emptying every
 * panel. The value mirrors devframe's own `ANONYMOUS_RPC_PREFIX` (currently
 * `"anonymous:"` in devframe 0.8, shipped with @vitejs/devtools 0.4). Kept as a
 * single source of truth so a future upstream rename is caught by
 * `test/index.test.ts` (which pins this against devframe's dist), not by silent
 * panel breakage.
 */
export const ANONYMOUS_RPC_PREFIX = "anonymous:";

export type PageMidiInjectCommand = DevMidiInjectCommand & { pageId: string };
export type PageMidiInject = { commands: PageMidiInjectCommand[] };

export type DevPage = { id: string; title: string; url: string };
export type DevPages = { pages: DevPage[] };
export type DevPageSnapshots<T> = { pages: Record<string, T> };
type Session = NonNullable<
  ReturnType<ViteDevToolsNodeContext["rpc"]["getCurrentRpcSession"]>
>["meta"];

export async function setupDevtoolsPages(ctx: ViteDevToolsNodeContext): Promise<() => void> {
  const { defineRpcFunction } = await import("@vitejs/devtools-kit");
  const pages = await ctx.rpc.sharedState.get("unworklet:pages", {
    initialValue: { pages: [] } as DevPages,
  });
  const graph = await ctx.rpc.sharedState.get("unworklet:page-graph", {
    initialValue: { pages: {} } as DevPageSnapshots<DevAudioGraph>,
  });
  const state = await ctx.rpc.sharedState.get("unworklet:page-state", {
    initialValue: { pages: {} } as DevPageSnapshots<DevLiveState>,
  });
  const signals = await ctx.rpc.sharedState.get("unworklet:page-signals", {
    initialValue: { pages: {} } as DevPageSnapshots<DevSignalsState>,
  });
  const midi = await ctx.rpc.sharedState.get("unworklet:page-midi", {
    initialValue: { pages: {} } as DevPageSnapshots<DevMidiState>,
  });
  const inject = await ctx.rpc.sharedState.get("unworklet:page-midi-inject", {
    initialValue: { commands: [] } as PageMidiInject,
  });
  const rawGraph = await ctx.rpc.sharedState.get("unworklet:graph", {
    initialValue: { nodes: [], edges: [] } as DevAudioGraph,
  });
  const rawState = await ctx.rpc.sharedState.get("unworklet:state", {
    initialValue: { nodes: [] } as DevLiveState,
  });
  const rawSignals = await ctx.rpc.sharedState.get("unworklet:signals", {
    initialValue: {
      nodes: [],
      context: { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 },
    } as DevSignalsState,
  });
  const rawMidi = await ctx.rpc.sharedState.get("unworklet:midi", {
    initialValue: { ports: [], log: [] } as DevMidiState,
  });
  const rawInject = await ctx.rpc.sharedState.get("unworklet:midi-inject", {
    initialValue: { commands: [] } as DevMidiInject,
  });
  const writeGraph = (data: DevAudioGraph): void => {
    rawGraph.mutate((draft) => {
      draft.nodes = data.nodes;
      draft.edges = data.edges;
    });
  };
  const writeState = (data: DevLiveState): void => {
    rawState.mutate((draft) => {
      draft.nodes = data.nodes;
    });
  };
  const writeSignals = (data: DevSignalsState): void => {
    rawSignals.mutate((draft) => {
      draft.nodes = data.nodes;
      draft.context = data.context;
    });
  };
  const writeMidi = (data: DevMidiState): void => {
    rawMidi.mutate((draft) => {
      draft.ports = data.ports;
      draft.log = data.log;
    });
  };
  const owners = new Map<string, Session>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let seq = 0;
  let unscopedSeq = 0;
  let disposed = false;
  // Idle background tabs remain valid; only a closed transport removes their data.
  const connected = (session: Session): boolean => !!session.peer?.peers.has(session.peer);
  const owns = (id: string): boolean => {
    const owner = owners.get(id);
    return !!owner && owner === ctx.rpc.getCurrentRpcSession()?.meta && connected(owner);
  };
  const remove = (id: string): void => {
    owners.delete(id);
    pages.mutate((draft) => {
      draft.pages = draft.pages.filter((p) => p.id !== id);
    });
    for (const shared of [graph, state, signals, midi]) {
      shared.mutate((draft) => {
        delete draft.pages[id];
      });
    }
    inject.mutate((draft) => {
      draft.commands = draft.commands.filter((c) => c.pageId !== id);
    });
    if (owners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const register = <T>(name: string, handler: (arg: T) => unknown): void => {
    ctx.rpc.register(
      defineRpcFunction({ name, type: "action", setup: () => ({ handler }) }) as Parameters<
        typeof ctx.rpc.register
      >[0],
    );
  };
  register<DevPage>(`${ANONYMOUS_RPC_PREFIX}unworklet:page-open`, (page) => {
    const session = ctx.rpc.getCurrentRpcSession()?.meta;
    if (
      disposed ||
      !session ||
      !connected(session) ||
      typeof page.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(page.id) ||
      owners.has(page.id)
    )
      return false;
    for (const [id, owner] of owners) if (owner === session) remove(id);
    owners.set(page.id, session);
    pages.mutate((draft) => {
      draft.pages.push(page);
    });
    if (!timer) {
      timer = setInterval(() => {
        for (const [id, owner] of owners) if (!connected(owner)) remove(id);
      }, 1000);
      timer.unref();
    }
    return true;
  });
  register<{ pageId: string }>(`${ANONYMOUS_RPC_PREFIX}unworklet:page-close`, ({ pageId }) => {
    if (owns(pageId)) remove(pageId);
  });
  register<{ pageId: string; data: DevAudioGraph }>(
    `${ANONYMOUS_RPC_PREFIX}unworklet:page-graph-update`,
    ({ pageId, data }) => {
      if (!owns(pageId)) return;
      graph.mutate((draft) => {
        draft.pages[pageId] = data;
      });
      writeGraph(data);
    },
  );
  register<{ pageId: string; data: DevLiveState }>(
    `${ANONYMOUS_RPC_PREFIX}unworklet:page-state-update`,
    ({ pageId, data }) => {
      if (!owns(pageId)) return;
      state.mutate((draft) => {
        draft.pages[pageId] = data;
      });
      writeState(data);
    },
  );
  register<{ pageId: string; data: DevSignalsState }>(
    `${ANONYMOUS_RPC_PREFIX}unworklet:page-signals-update`,
    ({ pageId, data }) => {
      if (!owns(pageId)) return;
      signals.mutate((draft) => {
        draft.pages[pageId] = data;
      });
      writeSignals(data);
    },
  );
  register<{ pageId: string; data: DevMidiState }>(
    `${ANONYMOUS_RPC_PREFIX}unworklet:page-midi-update`,
    ({ pageId, data }) => {
      if (!owns(pageId)) return;
      midi.mutate((draft) => {
        draft.pages[pageId] = data;
      });
      writeMidi(data);
    },
  );
  register(`${ANONYMOUS_RPC_PREFIX}unworklet:graph-update`, writeGraph);
  register(`${ANONYMOUS_RPC_PREFIX}unworklet:state-update`, writeState);
  register(`${ANONYMOUS_RPC_PREFIX}unworklet:signals-update`, writeSignals);
  register(`${ANONYMOUS_RPC_PREFIX}unworklet:midi-update`, writeMidi);
  const enqueue = (cmd: Omit<PageMidiInjectCommand, "seq">): void => {
    const owner = owners.get(cmd.pageId);
    if (!owner || !connected(owner)) return;
    const ports = midi.value().pages[cmd.pageId]?.ports ?? [];
    if (!ports.some((p) => p.nodeId === cmd.nodeId && p.name === cmd.port && p.direction === "in"))
      return;
    const next = ++seq;
    inject.mutate((draft) => {
      draft.commands = [...draft.commands, { ...cmd, seq: next }].slice(-64);
    });
  };
  register("unworklet:page-midi-inject", enqueue);
  register<Omit<DevMidiInjectCommand, "seq">>("unworklet:midi-inject", (cmd) => {
    const command = { nodeId: cmd.nodeId, port: cmd.port, event: cmd.event };
    rawInject.mutate((draft) => {
      draft.commands = [...draft.commands, { ...command, seq: ++unscopedSeq }].slice(-64);
    });
    for (const pageId of owners.keys()) enqueue({ ...command, pageId });
  });
  return () => {
    disposed = true;
    for (const id of owners.keys()) remove(id);
  };
}
