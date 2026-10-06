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
  const graph = await ctx.rpc.sharedState.get("unworklet:graph", {
    initialValue: { pages: {} } as DevPageSnapshots<DevAudioGraph>,
  });
  const state = await ctx.rpc.sharedState.get("unworklet:state", {
    initialValue: { pages: {} } as DevPageSnapshots<DevLiveState>,
  });
  const signals = await ctx.rpc.sharedState.get("unworklet:signals", {
    initialValue: { pages: {} } as DevPageSnapshots<DevSignalsState>,
  });
  const midi = await ctx.rpc.sharedState.get("unworklet:midi", {
    initialValue: { pages: {} } as DevPageSnapshots<DevMidiState>,
  });
  const inject = await ctx.rpc.sharedState.get("unworklet:midi-inject", {
    initialValue: { commands: [] } as DevMidiInject,
  });
  const owners = new Map<string, Session>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let seq = 0;
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
    `${ANONYMOUS_RPC_PREFIX}unworklet:graph-update`,
    ({ pageId, data }) => {
      if (owns(pageId))
        graph.mutate((draft) => {
          draft.pages[pageId] = data;
        });
    },
  );
  register<{ pageId: string; data: DevLiveState }>(
    `${ANONYMOUS_RPC_PREFIX}unworklet:state-update`,
    ({ pageId, data }) => {
      if (owns(pageId))
        state.mutate((draft) => {
          draft.pages[pageId] = data;
        });
    },
  );
  register<{ pageId: string; data: DevSignalsState }>(
    `${ANONYMOUS_RPC_PREFIX}unworklet:signals-update`,
    ({ pageId, data }) => {
      if (owns(pageId))
        signals.mutate((draft) => {
          draft.pages[pageId] = data;
        });
    },
  );
  register<{ pageId: string; data: DevMidiState }>(
    `${ANONYMOUS_RPC_PREFIX}unworklet:midi-update`,
    ({ pageId, data }) => {
      if (owns(pageId))
        midi.mutate((draft) => {
          draft.pages[pageId] = data;
        });
    },
  );
  register<Omit<DevMidiInjectCommand, "seq">>("unworklet:midi-inject", (cmd) => {
    const owner = owners.get(cmd.pageId);
    if (!owner || !connected(owner)) return;
    const ports = midi.value().pages[cmd.pageId]?.ports ?? [];
    if (!ports.some((p) => p.nodeId === cmd.nodeId && p.name === cmd.port && p.direction === "in"))
      return;
    inject.mutate((draft) => {
      draft.commands = [...draft.commands, { ...cmd, seq: ++seq }].slice(-64);
    });
  });
  return () => {
    disposed = true;
    for (const id of owners.keys()) remove(id);
  };
}
