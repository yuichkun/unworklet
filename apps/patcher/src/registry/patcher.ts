// patcher (subpatch) + inlet/outlet placeholders.
//
// A `patcher` node wraps a child Patch (stored as attrs.patch). At compile
// time, the inner patch is compiled into a `defineSubgraph` whose args are
// the inner `inlet` placeholders' resolved values, and whose return value
// is the array of `outlet` placeholders' incoming audio.

import * as core from "@unworklet/core";
import type { Node as UNode } from "@unworklet/core";
import type { Patch } from "../types";
import { register, registry } from "./store";

const EMPTY_PATCH: Patch = { nodes: [], cords: [] };

// Recursive: a sub-patch can itself contain patcher nodes.
register({
  type: "patcher",
  category: "structural",
  description: "Sub-patch. Double-click to descend; compiles to defineSubgraph.",
  inlets: [
    { kind: "audio", label: "in1" },
    { kind: "audio", label: "in2" },
    { kind: "audio", label: "in3" },
    { kind: "audio", label: "in4" },
  ],
  outlets: [
    { kind: "audio", label: "out1" },
    { kind: "audio", label: "out2" },
    { kind: "audio", label: "out3" },
    { kind: "audio", label: "out4" },
  ],
  attrs: [
    { name: "patch", kind: "patch", default: EMPTY_PATCH },
    { name: "inletCount", kind: "number", default: 2, min: 1, max: 4 },
    { name: "outletCount", kind: "number", default: 2, min: 1, max: 4 },
    { name: "name", kind: "string", default: "patcher" },
  ],
  defaultAttrs: {
    patch: EMPTY_PATCH,
    inletCount: 2,
    outletCount: 2,
    name: "patcher",
  },
  build: (ctx, _args, attrs) => {
    const inner = (attrs.patch as Patch) ?? EMPTY_PATCH;
    const inletCount = (attrs.inletCount as number) ?? 2;
    const outletCount = (attrs.outletCount as number) ?? 2;

    const sub = core.defineSubgraph((...args: UNode<"f32">[]) => {
      // Compile the inner patch in subgraph mode. We inline the build()
      // walk here rather than recursing into the top-level compile()
      // because we already have a captured-graph context (the parent
      // forSample is mid-flight).
      return compileInnerPatch(inner, args, inletCount, outletCount);
    });

    const outs = sub(
      ctx.inAudio(0),
      ctx.inAudio(1),
      ctx.inAudio(2),
      ctx.inAudio(3),
    );
    const result: UNode<"f32">[] = [];
    for (let i = 0; i < outletCount; i++) {
      result.push((outs[i] as UNode<"f32">) ?? (core.num(0) as UNode<"f32">));
    }
    return result;
  },
  component: "PatcherView",
});

// Inlet / outlet placeholders. Inside a subpatch, these forward subgraph
// args / produce subgraph return values. Outside a subpatch they're
// effectively no-ops (silence).
register({
  type: "inlet",
  category: "structural",
  description: "Subpatch inlet placeholder. Outlet emits the corresponding subgraph arg.",
  inlets: [],
  outlets: [{ kind: "audio", label: "in" }],
  attrs: [{ name: "index", kind: "number", default: 0, min: 0, max: 3 }],
  build: () => [core.num(0) as UNode<"f32">],
});

register({
  type: "outlet",
  category: "structural",
  description: "Subpatch outlet placeholder. Inlet feeds the corresponding subgraph return.",
  inlets: [{ kind: "audio", label: "out" }],
  outlets: [],
  attrs: [{ name: "index", kind: "number", default: 0, min: 0, max: 3 }],
  build: () => [],
});

// ─── inner-patch compiler ────────────────────────────────────────────────────
//
// Reduced version of compile.ts, walks the inner patch and threads the
// subgraph args through inlet placeholders, returning outlet values.

function compileInnerPatch(
  patch: Patch,
  subgraphArgs: UNode<"f32">[],
  _inletCount: number,
  outletCount: number,
): UNode<"f32">[] {
  const isControlCord = (cord: { src: { node: string; outlet: number } }) => {
    const srcNode = patch.nodes.find((n) => n.id === cord.src.node);
    if (!srcNode) return false;
    const def = registry[srcNode.type];
    if (!def) return false;
    const outlet = def.outlets[cord.src.outlet];
    return outlet?.kind === "control";
  };
  const isAudioCord = (c: any) => !isControlCord(c);

  // Topo sort.
  const nodes = patch.nodes;
  const idMap = new Map(nodes.map((n) => [n.id, n] as const));
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const cord of patch.cords) {
    if (!idMap.has(cord.src.node) || !idMap.has(cord.dst.node)) continue;
    adj.get(cord.src.node)!.push(cord.dst.node);
    indeg.set(cord.dst.node, (indeg.get(cord.dst.node) ?? 0) + 1);
  }
  const sorted: typeof nodes = [];
  const q: string[] = [];
  for (const [id, d] of indeg) if (d === 0) q.push(id);
  while (q.length) {
    const id = q.shift()!;
    sorted.push(idMap.get(id)!);
    for (const nb of adj.get(id) ?? []) {
      const d = (indeg.get(nb) ?? 0) - 1;
      indeg.set(nb, d);
      if (d === 0) q.push(nb);
    }
  }
  if (sorted.length < nodes.length) {
    throw new Error("Subpatch has a feedback cycle (use tapin~/tapout~).");
  }

  const outs = new Map<string, UNode<"f32">[]>();
  const resolveAudio = (dstId: string, inlet: number): UNode<"f32"> => {
    const incoming = patch.cords.filter(
      (c) => c.dst.node === dstId && c.dst.inlet === inlet && isAudioCord(c),
    );
    if (incoming.length === 0) return core.num(0) as UNode<"f32">;
    let acc: UNode<"f32"> | null = null;
    for (const cord of incoming) {
      const upstream = outs.get(cord.src.node);
      if (!upstream) continue;
      const val = upstream[cord.src.outlet];
      if (val == null) continue;
      acc = acc === null ? val : (acc.add(val) as UNode<"f32">);
    }
    return acc ?? (core.num(0) as UNode<"f32">);
  };
  const resolveControl = (dstId: string, inlet: number, fallback: number): UNode<"f32"> => {
    const incoming = patch.cords.filter(
      (c) => c.dst.node === dstId && c.dst.inlet === inlet,
    );
    for (const cord of incoming) {
      const upstream = outs.get(cord.src.node);
      if (!upstream) continue;
      const val = upstream[cord.src.outlet];
      if (val != null) return val;
    }
    return core.num(fallback) as UNode<"f32">;
  };

  for (const node of sorted) {
    const def = registry[node.type];
    if (!def) continue;
    if (node.type === "inlet") {
      const idx = (node.attrs?.index as number) ?? 0;
      outs.set(node.id, [(subgraphArgs[idx] as UNode<"f32">) ?? (core.num(0) as UNode<"f32">)]);
      continue;
    }
    // We can't access state/buffer outside the parent runtime; inside a
    // captured subgraph body we still call core.state etc. directly — the
    // capture backend handles it. Use the same BuildCtx shape as the
    // outer compiler.
    const buildCtx = {
      sampleRate: 48000, // passed to the build fn but typically ignored except where used
      i: core.num(0) as any, // we're already inside forSample at this point — but we don't expose it to subgraph builds
      inAudio: (inlet: number) => resolveAudio(node.id, inlet),
      inControl: (inlet: number, fallback: number) => resolveControl(node.id, inlet, fallback),
      state: core.state,
      buffer: core.buffer,
      id: node.id,
    };
    if (node.type === "outlet") {
      // outlet's "value" is what comes in from its inlet 0.
      const v = resolveAudio(node.id, 0);
      outs.set(node.id, [v]);
      continue;
    }
    const result = def.build(buildCtx as any, node.args ?? def.defaultArgs ?? [], {
      ...(def.defaultAttrs ?? {}),
      ...(node.attrs ?? {}),
    });
    outs.set(node.id, result);
  }

  // Collect outlets in index order.
  const outletNodes = nodes
    .filter((n) => n.type === "outlet")
    .sort((a, b) => ((a.attrs?.index as number) ?? 0) - ((b.attrs?.index as number) ?? 0));
  const result: UNode<"f32">[] = [];
  for (let i = 0; i < outletCount; i++) {
    const outNode = outletNodes[i];
    if (outNode) {
      const o = outs.get(outNode.id);
      result.push((o?.[0] as UNode<"f32">) ?? (core.num(0) as UNode<"f32">));
    } else {
      result.push(core.num(0) as UNode<"f32">);
    }
  }
  return result;
}
