/**
 * Live audio-graph topology (Wire 4). Reads the `unworklet:graph` shared state
 * the plugin server mirrors from the dev page-script's `AudioNode.connect`
 * capture, and lays the nodes out left-to-right by longest-path depth.
 *
 * This is real Web-Audio graph structure (no WASM memory). Per-node analysis
 * (declared I/O, params, diagnostics, live state) is filled by later wires.
 */

import type {} from "@vitejs/devtools-kit"; // makes the bare module augmentable below
import { getDevToolsRpcClient } from "@vitejs/devtools-kit/client";
import { DEVTOOLS_MOUNT_PATH } from "@vitejs/devtools-kit/constants";
import { computed, onMounted, ref } from "vue";

export type LiveGraphNode = {
  id: string;
  label: string;
  kind: "unworklet" | "standard";
  audioNodeType: string;
  /** Declared audio port names (unworklet nodes only). */
  inputs?: string[];
  outputs?: string[];
};
export type LiveGraphEdge = { id: string; from: string; to: string };
export type LiveGraph = { nodes: LiveGraphNode[]; edges: LiveGraphEdge[] };

export type PlacedNode = LiveGraphNode & { x: number; y: number };

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "unworklet:graph": LiveGraph;
  }
}

const COL_W = 210;
const COL_X0 = 60;
const ROW_H = 96;
const ROW_Y0 = 60;

/** Longest-path-from-source column per node, rows packed within each column. */
export function layout(graph: LiveGraph): PlacedNode[] {
  const col = new Map<string, number>();
  for (const n of graph.nodes) col.set(n.id, 0);
  // Relax edges |V| times to settle the longest-path depth. Clamp at |V|-1: a
  // feedback cycle (a valid Web-Audio topology, e.g. a delay routed back through
  // a gain) would otherwise keep incrementing its members' columns every pass and
  // blow the layout out to ~|V|² wide. A DAG's longest path never exceeds |V|-1,
  // so the clamp leaves acyclic graphs unchanged.
  const maxCol = Math.max(0, graph.nodes.length - 1);
  for (let i = 0; i < graph.nodes.length; i++) {
    for (const e of graph.edges) {
      if (!col.has(e.from) || !col.has(e.to)) continue;
      const c = Math.min((col.get(e.from) ?? 0) + 1, maxCol);
      if (c > (col.get(e.to) ?? 0)) col.set(e.to, c);
    }
  }
  const rowByCol = new Map<number, number>();
  return graph.nodes.map((n) => {
    const c = col.get(n.id) ?? 0;
    const r = rowByCol.get(c) ?? 0;
    rowByCol.set(c, r + 1);
    return { ...n, x: COL_X0 + c * COL_W, y: ROW_Y0 + r * ROW_H };
  });
}

export function useLiveGraph() {
  const graph = ref<LiveGraph>({ nodes: [], edges: [] });
  const selectedId = ref<string | null>(null);

  const apply = (g: LiveGraph | undefined): void => {
    graph.value = g ?? { nodes: [], edges: [] };
    if (selectedId.value && !graph.value.nodes.some((n) => n.id === selectedId.value)) {
      selectedId.value = null;
    }
  };

  onMounted(() => {
    // The dock panel runs in an iframe. The host overlay only initialises the
    // global client context on the TOP page — it explicitly skips iframes — so
    // `getDevToolsClientContext()` is never populated here. Instead the panel
    // opens its own RPC channel to the devtools backend, mounted at
    // DEVTOOLS_MOUNT_PATH on this same origin (mirrors how the host bootstraps
    // the embedded top-page client).
    const connect = async (): Promise<void> => {
      const rpc = await getDevToolsRpcClient({ baseURL: DEVTOOLS_MOUNT_PATH });
      const shared = await rpc.sharedState.get("unworklet:graph");
      // sharedState hands back a deep-readonly view; we only read it, so widen.
      apply(shared.value() as LiveGraph | undefined);
      shared.on("updated", (g) => apply(g as LiveGraph));
    };
    void connect().catch(() => {
      // Dev-only panel; if the backend is unreachable there is nothing to show.
    });
  });

  const placed = computed(() => layout(graph.value));
  const edges = computed(() => graph.value.edges);
  const selectedNode = computed(
    () => graph.value.nodes.find((n) => n.id === selectedId.value) ?? null,
  );
  const selectNode = (id: string): void => {
    selectedId.value = id;
  };

  return { graph, placed, edges, selectedId, selectedNode, selectNode };
}
