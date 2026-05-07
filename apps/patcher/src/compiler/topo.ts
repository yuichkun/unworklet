// Topological sort over audio cords. Audio cords are dataflow edges: the
// upstream node's output must be evaluated before the downstream node's
// input is read. Pure forward edges form a DAG; explicit feedback nodes
// (tapin~/tapout~) introduce break-edges that the compiler is allowed to
// step around.

import type { Patch, PatchNode } from "../types";

type FeedbackBreak = { from: string; to: string };

export function topoSort(
  patch: Patch,
  isAudioCord: (cord: { src: { node: string }; dst: { node: string } }) => boolean,
  feedbackBreaks: FeedbackBreak[] = [],
): { order: PatchNode[]; cycle?: string[] } {
  const breakSet = new Set(feedbackBreaks.map((b) => `${b.from}->${b.to}`));
  const nodes = patch.nodes;
  const idMap = new Map(nodes.map((n) => [n.id, n] as const));

  const adj = new Map<string, string[]>(); // upstream -> downstream
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const cord of patch.cords) {
    if (!isAudioCord(cord)) continue;
    const key = `${cord.src.node}->${cord.dst.node}`;
    if (breakSet.has(key)) continue;
    if (!idMap.has(cord.src.node) || !idMap.has(cord.dst.node)) continue;
    adj.get(cord.src.node)!.push(cord.dst.node);
    indeg.set(cord.dst.node, (indeg.get(cord.dst.node) ?? 0) + 1);
  }

  const order: PatchNode[] = [];
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);

  while (queue.length) {
    const id = queue.shift()!;
    order.push(idMap.get(id)!);
    for (const nb of adj.get(id) ?? []) {
      const d = (indeg.get(nb) ?? 0) - 1;
      indeg.set(nb, d);
      if (d === 0) queue.push(nb);
    }
  }

  if (order.length < nodes.length) {
    // Cycle present and no feedback break covered it.
    const remaining = nodes.filter((n) => !order.includes(n)).map((n) => n.id);
    return { order, cycle: remaining };
  }
  return { order };
}
