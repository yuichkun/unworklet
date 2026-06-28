/**
 * Live state X-ray. Reads the `unworklet:state` shared state the plugin server
 * mirrors from the dev page-script's `devDump()` poll, and keeps a rolling
 * history per scalar slot for sparklines.
 *
 * Scalar slots (state / param) carry real decoded values; buffer slots carry
 * their decoded elements (stride-downsampled when large — `length` is the true
 * count). i64 scalar values arrive as decimal strings (JSON has no bigint).
 */

import type {} from "@vitejs/devtools-kit"; // makes the bare module augmentable below
import { getPanelRpc } from "../lib/rpc";
import { computed, onMounted, shallowRef } from "vue";

export type LiveSlotType = "f32" | "f64" | "i32" | "i64" | "bool" | "u8";
export type LiveScalar = {
  name: string;
  kind: "state" | "param";
  type: LiveSlotType;
  value: number | boolean | string;
};
export type LiveBuffer = {
  name: string;
  type: LiveSlotType;
  length: number;
  data: number[];
  downsampled: boolean;
};
export type LiveNodeState = {
  id: string;
  displayName: string;
  scalars: LiveScalar[];
  buffers: LiveBuffer[];
};
export type LiveState = { nodes: LiveNodeState[] };

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "unworklet:state": LiveState;
  }
}

const HISTORY_LEN = 150;

/**
 * Coerce a (possibly partial) shared-state payload into a well-formed
 * {@link LiveState}. Shared state can be the empty initial value, or — across a
 * dev restart — a payload from a mismatched plugin version that omits a node's
 * arrays or a buffer's `data`. Normalizing here means the template renders empty
 * instead of throwing (e.g. `formatHex(b.data)` on an absent `data`).
 */
export function normalizeLiveState(s: LiveState | undefined): LiveState {
  return {
    nodes: (s?.nodes ?? []).map((n) => ({
      id: n.id,
      displayName: n.displayName,
      scalars: n.scalars ?? [],
      buffers: (n.buffers ?? []).map((b) => ({ ...b, data: b.data ?? [] })),
    })),
  };
}

/** Charting projection of a scalar value: number / bool→0|1, i64 string → none. */
export function numericOf(v: number | boolean | string): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return undefined; // i64 decimal string — not charted
}

export function useLiveState() {
  // shallowRef: `apply` always replaces `state.value` wholesale, so a shallow
  // ref triggers updates on every poll without Vue deep-tracking the (up to
  // 512-element) buffer arrays inside each node — that deep tracking was the
  // source of the panel's re-render churn.
  const state = shallowRef<LiveState>({ nodes: [] });
  const histories = new Map<string, number[]>();

  const apply = (s: LiveState | undefined): void => {
    const nodes = normalizeLiveState(s).nodes;
    state.value = { nodes };
    const present = new Set<string>();
    for (const n of nodes) {
      for (const sc of n.scalars) {
        const scalarVal = numericOf(sc.value);
        if (scalarVal === undefined) continue;
        const key = `${n.id}.${sc.name}`;
        present.add(key);
        let arr = histories.get(key);
        if (!arr) {
          arr = [];
          histories.set(key, arr);
        }
        arr.push(scalarVal);
        if (arr.length > HISTORY_LEN) arr.shift();
      }
    }
    // Drop histories for slots no longer present (a disposed node / removed slot)
    // so the map doesn't retain a 150-sample array per vanished scalar for the
    // iframe's lifetime as node ids climb (mirrors useLiveSignals' frame reconcile).
    for (const key of histories.keys()) if (!present.has(key)) histories.delete(key);
  };

  onMounted(() => {
    // Token-trusted devtools connection shared across views (see `getPanelRpc`).
    const connect = async (): Promise<void> => {
      const rpc = await getPanelRpc();
      const shared = await rpc.sharedState.get("unworklet:state");
      apply(shared.value() as LiveState | undefined);
      shared.on("updated", (s) => apply(s as LiveState));
    };
    void connect().catch(() => {
      // Dev-only panel; nothing to show if the backend is unreachable.
    });
  });

  const nodes = computed(() => state.value.nodes);
  const totalScalars = computed(() =>
    state.value.nodes.reduce((acc, n) => acc + n.scalars.length, 0),
  );
  const getHistory = (nodeId: string, slotName: string): readonly number[] =>
    histories.get(`${nodeId}.${slotName}`) ?? [];

  return { nodes, totalScalars, getHistory };
}
