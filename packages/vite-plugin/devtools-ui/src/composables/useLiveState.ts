/**
 * Live state X-ray. Reads the `unworklet:state` shared state the plugin server
 * mirrors from the dev page-script's `devDump()` poll, and keeps a rolling
 * history per scalar slot for sparklines.
 *
 * Scalar slots (state / param) carry real decoded values; buffer slots carry
 * metadata only (name / type / length) — their byte visualization is a later
 * wire. i64 values arrive as decimal strings (JSON has no bigint).
 */

import type {} from "@vitejs/devtools-kit"; // makes the bare module augmentable below
import { getDevToolsRpcClient } from "@vitejs/devtools-kit/client";
import { DEVTOOLS_MOUNT_PATH } from "@vitejs/devtools-kit/constants";
import { computed, onMounted, ref } from "vue";

export type LiveSlotType = "f32" | "f64" | "i32" | "i64" | "bool" | "u8";
export type LiveScalar = {
  name: string;
  kind: "state" | "param";
  type: LiveSlotType;
  value: number | boolean | string;
};
export type LiveBufferMeta = { name: string; type: LiveSlotType; length: number };
export type LiveNodeState = {
  id: string;
  displayName: string;
  scalars: LiveScalar[];
  buffers: LiveBufferMeta[];
};
export type LiveState = { nodes: LiveNodeState[] };

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "unworklet:state": LiveState;
  }
}

const HISTORY_LEN = 150;

export function useLiveState() {
  const state = ref<LiveState>({ nodes: [] });
  const histories = new Map<string, number[]>();

  const numericOf = (v: number | boolean | string): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    return undefined; // i64 decimal string — not charted
  };

  const apply = (s: LiveState | undefined): void => {
    const next = s ?? { nodes: [] };
    state.value = next;
    for (const n of next.nodes) {
      for (const sc of n.scalars) {
        const num = numericOf(sc.value);
        if (num === undefined) continue;
        const key = `${n.id}.${sc.name}`;
        let arr = histories.get(key);
        if (!arr) {
          arr = [];
          histories.set(key, arr);
        }
        arr.push(num);
        if (arr.length > HISTORY_LEN) arr.shift();
      }
    }
  };

  onMounted(() => {
    // The dock panel runs in an iframe; open its own RPC channel to the backend
    // (mirrors useLiveGraph — the host only seeds the client context on the top page).
    const connect = async (): Promise<void> => {
      const rpc = await getDevToolsRpcClient({ baseURL: DEVTOOLS_MOUNT_PATH });
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
