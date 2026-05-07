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

import type { Patch, PatchNode, BuildCtx, NodeDef, ParamSpec } from "../types";
import { topoSort } from "./topo";
import { registry } from "../registry";

export type ParamRoute = {
  /** Patch node id this param belongs to. */
  nodeId: string;
  /** Which outlet index of that node the param drives. */
  outletIndex: number;
  /** The original ParamSpec, useful for runtime range/rate decisions. */
  spec: ParamSpec;
};

export type MidiInputRoute = {
  /** Patch node id (notein / ctlin / pitchbend). */
  nodeId: string;
  kind: "note" | "cc" | "pitchbend";
  /** Optional channel filter (1..16); undefined = omni. */
  channel?: number;
  /** For cc: which controller number to listen for. */
  controller?: number;
};

export type MidiOutputRoute = {
  nodeId: string;
  kind: "note" | "cc" | "raw";
  /** Optional channel (1..16); undefined = ch1. */
  channel: number;
  /** For cc: which controller number to send. */
  controller?: number;
  /** Names of published state slots the runtime subscribes to.
   *  - note: [noteName, velName, gateName]
   *  - cc:   [valueName]
   *  - raw:  [statusName]
   *  These match the names declared in registry/midi.ts build() bodies. */
  stateNames: string[];
};

export type CompileResult = {
  processor: CompiledProcessor;
  /** Map compiled param name → ParamRoute. The runtime uses this to route
   *  slider/dial value changes to the right AudioParam, and to know which
   *  outlet each param drives for nodes with multiple param outlets
   *  (kslider note+gate, notein note+vel+gate, etc.). */
  paramRouting: Record<string, ParamRoute>;
  /** MIDI input listeners: which patch nodes want which MIDI events. */
  midiInputs: MidiInputRoute[];
  /** MIDI output bus: which patch nodes emit events forwarded to MIDIOutputs. */
  midiOutputs: MidiOutputRoute[];
  /** Adc / dac topology so the runtime knows how to connect mic / destination. */
  ioRouting: {
    inputs: Array<{ name: string; channels: number }>;
    outputs: Array<{ name: string; channels: number }>;
  };
};

function getParamSpecs(def: NodeDef): ParamSpec[] {
  if (def.paramSpecs && def.paramSpecs.length > 0) return def.paramSpecs;
  if (def.paramSpec) return [{ ...def.paramSpec, outletIndex: def.paramSpec.outletIndex ?? 0 }];
  return [];
}

export function patchToProcessor(patch: Patch): CompileResult {
  // Collect nodes with paramSpec / ioSpec — these need to be declared at
  // setup time, before forSample.
  const paramRouting: Record<string, ParamRoute> = {};
  const midiInputs: MidiInputRoute[] = [];
  const midiOutputs: MidiOutputRoute[] = [];
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

  // Feedback breaks: a cord from `tapin~` to `tapout~` (or any explicit
  // feedback-write→feedback-read declarative pair) is removed from the
  // topo graph. Data flows via the shared bus, not the cord, so the cord
  // is only a visual / declarative connection. Without the break, a typical
  // Karplus-Strong-style patch (`+~ → tapin~ → tapout~ → filter → +~`)
  // forms a cycle.
  const feedbackBreaks: Array<{ from: string; to: string }> = [];
  for (const cord of patch.cords) {
    const src = patch.nodes.find((n) => n.id === cord.src.node);
    const dst = patch.nodes.find((n) => n.id === cord.dst.node);
    if (!src || !dst) continue;
    if (src.type === "tapin~" && dst.type === "tapout~") {
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
    const specs = getParamSpecs(def);
    if (specs.length > 0) {
      for (let si = 0; si < specs.length; si++) {
        const spec = specs[si]!;
        const cname = paramName(n.id, si);
        paramRouting[cname] = {
          nodeId: n.id,
          outletIndex: spec.outletIndex ?? si,
          spec,
        };
      }
      // If the def declares a midiSpec direction:"in", route MIDI events to
      // those params at runtime via setParam(nodeId, value, outletIndex).
      if (def.midiSpec?.direction === "in") {
        const channel = (n.attrs?.channel as number | undefined);
        const controller = (n.attrs?.controller as number | undefined);
        midiInputs.push({
          nodeId: n.id,
          kind: def.midiSpec.kind === "raw" ? "cc" : def.midiSpec.kind,
          channel,
          controller,
        });
      }
    }
    if (def.midiSpec?.direction === "out") {
      const channel = ((n.attrs?.channel as number | undefined) ?? 1) || 1;
      const controller = n.attrs?.controller as number | undefined;
      let stateNames: string[];
      if (def.midiSpec.kind === "note") {
        stateNames = [`noteout_${n.id}_note`, `noteout_${n.id}_vel`, `noteout_${n.id}_gate`];
      } else if (def.midiSpec.kind === "cc") {
        stateNames = [`ctlout_${n.id}_v`];
      } else {
        stateNames = [`midiout_${n.id}_b`];
      }
      midiOutputs.push({
        nodeId: n.id,
        kind: def.midiSpec.kind === "pitchbend" ? "raw" : (def.midiSpec.kind as "note" | "cc" | "raw"),
        channel: Math.max(1, Math.min(16, channel)),
        controller,
        stateNames,
      });
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
    /** Per-node array of declared params (one per spec), aligned to outletIndex. */
    const paramsByNode: Record<string, Array<{ p: ReturnType<typeof param>; spec: ParamSpec }>> = {};

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
      const specs = getParamSpecs(def);
      if (specs.length > 0) {
        const arr: Array<{ p: ReturnType<typeof param>; spec: ParamSpec }> = [];
        for (let si = 0; si < specs.length; si++) {
          const spec = specs[si]!;
          const cname = paramName(n.id, si);
          // Per-instance attrs (set by sliders/dials) override the registry
          // defaults. AudioParam validates min ≤ default ≤ max — if the
          // user overrode min/max, the default has to land inside.
          // For multi-paramSpec nodes (kslider note+gate), only the first
          // spec reads min/max overrides — additional specs use spec defaults.
          const min = si === 0 ? (n.attrs?.min as number) ?? spec.min : spec.min;
          const max = si === 0 ? (n.attrs?.max as number) ?? spec.max : spec.max;
          const rawDefault = (n.attrs?.[spec.name] as number) ?? spec.default;
          const initial = Math.max(min, Math.min(max, rawDefault));
          arr.push({
            p: param({
              name: cname,
              default: initial,
              min,
              max,
              automationRate: spec.automationRate,
            }),
            spec,
          });
        }
        paramsByNode[n.id] = arr;
      }
    }

    // Shared resources keyed by patch-level bus names — used so multiple
    // tapin~/tapout~ on the same `bus` actually read/write the same buffer
    // (Max convention; previously each node had its own private buffer).
    const sharedRegistry = new Map<string, unknown>();
    const shared = <T,>(key: string, factory: () => T): T => {
      if (sharedRegistry.has(key)) return sharedRegistry.get(key) as T;
      const v = factory();
      sharedRegistry.set(key, v);
      return v;
    };

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
            const specs = getParamSpecs(def);
            if (specs.length > 0) {
              // slider / dial / kslider / notein etc. — produce one Node<f32>
              // per declared paramSpec, ordered by outletIndex.
              const arr = paramsByNode[node.id] ?? [];
              const outletCount = Math.max(
                def.outlets.length,
                ...arr.map((a) => (a.spec.outletIndex ?? 0) + 1),
              );
              const outsArr: UNode<"f32">[] = new Array(outletCount).fill(null as any);
              for (let si = 0; si < arr.length; si++) {
                const entry = arr[si]!;
                const idx = entry.spec.outletIndex ?? si;
                const v = entry.spec.automationRate === "a-rate" ? entry.p.at(i) : entry.p.at(0);
                outsArr[idx] = v;
              }
              // Fill any remaining outlet slots with 0 to keep cord lookups safe.
              for (let k = 0; k < outsArr.length; k++) {
                if (outsArr[k] == null) outsArr[k] = num(0) as UNode<"f32">;
              }
              outs.set(node.id, outsArr);
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
              shared,
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

  return { processor, paramRouting, midiInputs, midiOutputs, ioRouting };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export function paramName(nodeId: string, outletIndex: number = 0): string {
  // The Web Audio AudioParam name has to be a valid identifier-ish thing.
  const safe = nodeId.replace(/[^A-Za-z0-9_]/g, "_");
  return outletIndex === 0 ? `p_${safe}` : `p_${safe}_${outletIndex}`;
}

export function ioName(nodeId: string, direction: "in" | "out"): string {
  return `${direction}_${nodeId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function eventName(nodeId: string, suffix: string): string {
  const safe = nodeId.replace(/[^A-Za-z0-9_]/g, "_");
  return `evt_${safe}_${suffix.replace(/[^A-Za-z0-9_]/g, "_")}`;
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
