// Patch → CompiledProcessor.
//
// Walks the patch in audio-dataflow order; each node's `build` contributes
// to the captured graph inside a single `forSample` body. Sliders / dials /
// number boxes that emit control values are mapped to `param()` declarations
// on the compiled processor, so live UI tweaks become AudioParam writes
// (no recompile required).

import {
  defineProcessor,
  audioInput,
  audioOutput,
  forSample,
  state as stateNs,
  buffer as bufferNs,
  param,
  num,
  type Node as UNode,
  type ProcessorContext,
} from "@unworklet/core";
import type { CompiledProcessor } from "@unworklet/core";

import type { Patch, PatchNode, BuildCtx, NodeDef } from "../types";
import { topoSort } from "./topo";
import { registry } from "../registry";

export type CompileResult = {
  processor: CompiledProcessor;
  /** Map of compiled param name → patch node id. The runtime uses this to
   *  route slider/dial value changes to the right AudioParam. */
  paramRouting: Record<string, string>;
  /** Adc / dac topology so the runtime knows how to connect mic / destination. */
  ioRouting: {
    inputs: Array<{ name: string; channels: number }>;
    outputs: Array<{ name: string; channels: number }>;
  };
};

export function patchToProcessor(patch: Patch): CompileResult {
  // Collect nodes with paramSpec / ioSpec — these need to be declared at
  // setup time, before forSample.
  const paramRouting: Record<string, string> = {};
  const ioRouting: CompileResult["ioRouting"] = { inputs: [], outputs: [] };

  // Track which cords are audio cords (vs control). We treat any cord whose
  // upstream node has a paramSpec OR whose source outlet is declared
  // control as a control cord; everything else is audio.
  const isControlCord = (cord: { src: { node: string; outlet: number } }) => {
    const srcNode = patch.nodes.find((n) => n.id === cord.src.node);
    if (!srcNode) return false;
    const def = registry[srcNode.type];
    if (!def) return false;
    const outlet = def.outlets[cord.src.outlet];
    return outlet?.kind === "control";
  };
  const isAudioCord = (cord: any) => !isControlCord(cord);

  // Detect feedback breaks: a cord whose dst is `tapout~` style (feedback
  // sink) is treated as a backward edge during topo sort. We don't have
  // tapout yet, so for now: nothing; cycles surface as compile errors.
  const feedbackBreaks: Array<{ from: string; to: string }> = [];
  for (const cord of patch.cords) {
    const dst = patch.nodes.find((n) => n.id === cord.dst.node);
    const def = dst && registry[dst.type];
    if (def?.attrs?.some((a) => a.name === "__feedbackInlet")) {
      feedbackBreaks.push({ from: cord.src.node, to: cord.dst.node });
    }
  }

  const sorted = topoSort(patch, isAudioCord, feedbackBreaks);
  if (sorted.cycle?.length) {
    throw new Error(
      `Patch has a feedback cycle through nodes ${sorted.cycle.join(", ")}. Use tapin~/tapout~ for explicit feedback.`,
    );
  }

  // Pre-pass: register paramSpec + ioSpec, generate unique compiled names.
  for (const n of patch.nodes) {
    const def = registry[n.type];
    if (!def) continue;
    if (def.paramSpec) {
      paramRouting[paramName(n.id)] = n.id;
    }
    if (def.ioSpec) {
      const meta = { name: ioName(n.id, def.ioSpec.direction), channels: def.ioSpec.channels };
      if (def.ioSpec.direction === "in") ioRouting.inputs.push(meta);
      else ioRouting.outputs.push(meta);
    }
  }

  const processor = defineProcessor((ctx: ProcessorContext) => {
    // ─── declarations ───────────────────────────────────────────────────
    // I/O ports.
    const audioIns: Record<string, ReturnType<typeof audioInput>> = {};
    const audioOuts: Record<string, ReturnType<typeof audioOutput>> = {};
    const params: Record<string, ReturnType<typeof param>> = {};

    for (const n of patch.nodes) {
      const def = registry[n.type];
      if (!def) continue;
      if (def.ioSpec) {
        const cname = ioName(n.id, def.ioSpec.direction);
        if (def.ioSpec.direction === "in") {
          audioIns[n.id] = audioInput({ channels: def.ioSpec.channels as any, name: cname });
        } else {
          audioOuts[n.id] = audioOutput({ channels: def.ioSpec.channels as any, name: cname });
        }
      }
      if (def.paramSpec) {
        const cname = paramName(n.id);
        // Per-instance attrs (set by sliders/dials) override the registry
        // defaults. AudioParam validates min ≤ default ≤ max — if the
        // user overrode min/max, the default has to land inside.
        const min = (n.attrs?.min as number) ?? def.paramSpec.min;
        const max = (n.attrs?.max as number) ?? def.paramSpec.max;
        const rawDefault =
          (n.attrs?.[def.paramSpec.name] as number) ?? def.paramSpec.default;
        const initial = Math.max(min, Math.min(max, rawDefault));
        params[n.id] = param({
          name: cname,
          default: initial,
          min,
          max,
          automationRate: def.paramSpec.automationRate,
        });
      }
    }

    return {
      process: () => {
        forSample((i) => {
          // ─── per-node evaluation, in topo order ─────────────────────
          const outs = new Map<string, UNode<"f32">[]>();
          for (const node of sorted.order) {
            const def = registry[node.type];
            if (!def) continue;

            // Special handling for io & param-emitter nodes — they don't
            // really `build` per se, but they need to surface a value
            // for downstream cords.
            if (def.ioSpec?.direction === "in") {
              // adc~ — outlets pick up audio input channels
              const ai = audioIns[node.id]!;
              const outArr: UNode<"f32">[] = [];
              for (let c = 0; c < def.ioSpec.channels; c++) {
                outArr.push(ai.at(c as any, i));
              }
              outs.set(node.id, outArr);
              continue;
            }
            if (def.paramSpec) {
              // slider / dial / number-box etc. — single control outlet
              const p = params[node.id]!;
              const val = def.paramSpec.automationRate === "a-rate" ? p.at(i) : p.at(0);
              outs.set(node.id, [val]);
              continue;
            }

            // Normal node: build via the registry function with a BuildCtx.
            const buildCtx: BuildCtx = {
              sampleRate: ctx.sampleRate,
              i,
              inAudio: (inlet: number) => resolveAudio(node, inlet, outs, patch, isAudioCord),
              inControl: (inlet: number, fallback: number) =>
                resolveControl(node, inlet, fallback, outs, patch),
              state: stateNs as any,
              buffer: bufferNs as any,
              id: node.id,
            };

            if (def.ioSpec?.direction === "out") {
              // dac~ — pulls audio from its inlets and writes to output ports.
              const ao = audioOuts[node.id]!;
              for (let c = 0; c < def.ioSpec.channels; c++) {
                const sig = buildCtx.inAudio(c);
                ao.set(c as any, i, sig);
              }
              outs.set(node.id, []);
              continue;
            }

            const result = def.build(buildCtx, node.args ?? def.defaultArgs ?? [], {
              ...(def.defaultAttrs ?? {}),
              ...(node.attrs ?? {}),
            });
            outs.set(node.id, result);
          }
        });
      },
    };
  });

  return { processor, paramRouting, ioRouting };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export function paramName(nodeId: string): string {
  // The Web Audio AudioParam name has to be a valid identifier-ish thing.
  return `p_${nodeId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function ioName(nodeId: string, direction: "in" | "out"): string {
  return `${direction}_${nodeId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function resolveAudio(
  dstNode: PatchNode,
  inlet: number,
  outs: Map<string, UNode<"f32">[]>,
  patch: Patch,
  _isAudioCord: (c: any) => boolean,
): UNode<"f32"> {
  // Sum all incoming cords on this inlet (Max-style — audio-rate inlets
  // mix multiple connections). Control-rate sources (sliders, dials,
  // number-boxes) flow into audio inlets too, just like in Max — at the
  // captured-graph level both are Node<f32>.
  const incoming = patch.cords.filter(
    (c) => c.dst.node === dstNode.id && c.dst.inlet === inlet,
  );
  if (incoming.length === 0) return num(0) as UNode<"f32">;
  let acc: UNode<"f32"> | null = null;
  for (const cord of incoming) {
    const upstream = outs.get(cord.src.node);
    if (!upstream) continue;
    const val = upstream[cord.src.outlet];
    if (val == null) continue;
    acc = acc === null ? val : (acc.add(val) as UNode<"f32">);
  }
  return acc ?? (num(0) as UNode<"f32">);
}

function resolveControl(
  dstNode: PatchNode,
  inlet: number,
  fallback: number,
  outs: Map<string, UNode<"f32">[]>,
  patch: Patch,
): UNode<"f32"> {
  // Control inlets take the *first* cord (Max convention; later cords replace).
  const incoming = patch.cords.filter(
    (c) => c.dst.node === dstNode.id && c.dst.inlet === inlet,
  );
  for (const cord of incoming) {
    const upstream = outs.get(cord.src.node);
    if (!upstream) continue;
    const val = upstream[cord.src.outlet];
    if (val != null) return val;
  }
  return num(fallback) as UNode<"f32">;
}
