/**
 * Pure transforms for the DevTools page-script (the dev bridge). They run in the
 * browser — imported by the injected page-script via `@unworklet/vite-plugin/devbridge`
 * — but are plain data functions with no browser globals, so they are unit-tested
 * directly in Node (`devbridge.test.ts`). Keeping them here, rather than inline in
 * the page-script string, is what makes that coverage possible.
 */

import { decodeScalar, decodeTypedArray } from "@unworklet/core";

export type DevSlotType = "f32" | "f64" | "i32" | "i64" | "bool" | "u8";

/** One slot as `devDump()` returns it: raw little-endian bytes tagged by kind/type. */
export type RawSlot = {
  name: string;
  kind: "state" | "param" | "buffer";
  type: DevSlotType;
  data: Uint8Array;
};

export type DevStateScalar = {
  name: string;
  kind: "state" | "param";
  type: DevSlotType;
  value: number | boolean | string;
};
export type DevStateBuffer = {
  name: string;
  type: DevSlotType;
  length: number;
  data: number[];
  downsampled: boolean;
};

/**
 * Decode a node's dumped slots into JSON-safe live values: scalars carry their
 * decoded value (i64 as a decimal string — JSON has no bigint); buffers carry
 * their decoded elements, stride-downsampled to `maxBufferPoints` when larger
 * (`length` always reports the true element count). The worklet already copied
 * the bytes — downsampling here only keeps the wire light.
 */
export function splitSlots(
  slots: readonly RawSlot[],
  maxBufferPoints: number,
): { scalars: DevStateScalar[]; buffers: DevStateBuffer[] } {
  const scalars: DevStateScalar[] = [];
  const buffers: DevStateBuffer[] = [];
  for (const s of slots) {
    if (s.kind === "buffer") {
      const arr = decodeTypedArray(s.type, s.data);
      const length = arr.length;
      if (length <= maxBufferPoints) {
        buffers.push({
          name: s.name,
          type: s.type,
          length,
          data: Array.from(arr as ArrayLike<number | bigint>, Number),
          downsampled: false,
        });
      } else {
        const stride = length / maxBufferPoints;
        const src = arr as ArrayLike<number | bigint>;
        const data = Array.from({ length: maxBufferPoints }, (_, i) =>
          Number(src[Math.floor(i * stride)]),
        );
        buffers.push({ name: s.name, type: s.type, length, data, downsampled: true });
      }
    } else {
      // A scalar slot's type is always a ScalarType (u8 is buffer-only); the
      // RawSlot type can't express that, so narrow to decodeScalar's parameter.
      const v = decodeScalar(s.type as Parameters<typeof decodeScalar>[0], s.data);
      scalars.push({
        name: s.name,
        kind: s.kind,
        type: s.type,
        value: typeof v === "bigint" ? v.toString() : v,
      });
    }
  }
  return { scalars, buffers };
}

/**
 * Fold each unworklet node's internal input-proxy gain out of a captured audio
 * graph. Every unworklet node fronts each audio input with a proxy GainNode
 * (createNode wires proxyGain → AudioWorkletNode); the app never authored those,
 * so an edge INTO a proxy becomes an edge into its owner, the proxy's own
 * outgoing edge is dropped, and the proxy is omitted from the node list. The
 * result is exactly the connections the app wrote.
 *
 * `proxyOwner` maps a proxy node id to its owning unworklet node id. Generic over
 * the node shape so it stays decoupled from the DevTools graph types.
 */
export function foldProxyGraph<T extends { id: string }>(
  nodes: readonly T[],
  edges: ReadonlyArray<{ from: string; to: string }>,
  proxyOwner: Readonly<Record<string, string>>,
): { nodes: T[]; edges: Array<{ id: string; from: string; to: string }> } {
  const outNodes = nodes.filter((n) => proxyOwner[n.id] === undefined);
  const outEdges: Array<{ id: string; from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (proxyOwner[e.from] !== undefined) continue; // drop proxy → AudioWorkletNode plumbing
    const to = proxyOwner[e.to] ?? e.to; // fold edge-into-proxy onto the owner
    if (to === e.from) continue; // never a self-loop
    const id = `${e.from}>${to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    outEdges.push({ id, from: e.from, to });
  }
  return { nodes: outNodes, edges: outEdges };
}
