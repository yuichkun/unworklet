// Core data model + interface contracts for the patcher.
//
// A patch is a JSON-serialisable graph of nodes + cords; the compiler walks
// it once, calls each node's build(ctx) inside an emitted defineProcessor
// body, and ships a real WASM AudioWorkletNode out the other side.

import type { Node as UNode } from "@unworklet/core";

export type Patch = {
  nodes: PatchNode[];
  cords: Cord[];
};

export type PatchNode = {
  id: string;
  type: string; // registry key, e.g. "cycle~", "*~", "dac~", "gen~", "patcher"
  pos: { x: number; y: number };
  args?: any[]; // creation args, e.g. [440] for cycle~ 440
  attrs?: Record<string, any>; // mutable per-instance settings (slider value, gen~ code, etc.)
};

export type Cord = {
  src: { node: string; outlet: number };
  dst: { node: string; inlet: number };
};

// ─── Registry shape ─────────────────────────────────────────────────────────

export type PortKind = "audio" | "control";

export type PortDef = {
  kind: PortKind;
  /** Short label shown in tooltips — e.g. "freq", "in L", "trig". */
  label: string;
  /** Default value when no cord is connected (control inputs only). */
  default?: number;
};

export type AttrDef = {
  name: string;
  /** UI hint for the inspector. */
  kind: "number" | "string" | "boolean" | "code" | "select" | "patch";
  default: any;
  min?: number;
  max?: number;
  options?: string[];
};

export type BuildCtx = {
  sampleRate: number;
  /** The captured forSample loop var. */
  i: UNode<"i32">;
  /** Resolve audio inlet — returns Node<f32>; 0 if no cord. */
  inAudio: (inlet: number) => UNode<"f32">;
  /** Resolve control inlet — returns Node<f32> if control upstream is a-rate
   *  ParamHandle, else returns the static fallback as a graph constant. */
  inControl: (inlet: number, fallback: number) => UNode<"f32">;
  /** Per-instance state slot (auto-namespaced). */
  state: typeof import("@unworklet/core").state;
  /** Per-instance buffer slot (auto-namespaced). */
  buffer: typeof import("@unworklet/core").buffer;
  /** Stable id for naming state/buffers. */
  id: string;
};

export type NodeDef = {
  type: string;
  category:
    | "audio-osc"
    | "audio-math"
    | "audio-trig"
    | "audio-filter"
    | "audio-delay"
    | "audio-env"
    | "audio-dyn"
    | "audio-routing"
    | "audio-conv"
    | "audio-sampling"
    | "audio-viz"
    | "audio-io"
    | "control"
    | "midi"
    | "ui"
    | "structural";
  /** One-line summary shown in the node palette + inspector. */
  description?: string;
  inlets: PortDef[];
  outlets: PortDef[];
  attrs?: AttrDef[];
  /** Default args for new instances. */
  defaultArgs?: any[];
  /** Default attrs for new instances. */
  defaultAttrs?: Record<string, any>;
  /** Build-time contribution to the unworklet graph.
   *  Returns one Node<f32> per audio outlet (in order). */
  build: (
    ctx: BuildCtx,
    args: any[],
    attrs: Record<string, any>,
  ) => UNode<"f32">[];
  /** Custom Vue component for the node body in the canvas (defaults to AudioNode.vue). */
  component?: string;
  /** Some nodes (sliders, dials, etc.) emit a control value via a Web Audio
   *  AudioParam declared on the compiled processor. The compiler picks up
   *  the param meta to generate the param() declaration. */
  paramSpec?: {
    name: string; // mapped to a unique compiled name
    default: number;
    min: number;
    max: number;
    automationRate: "k-rate" | "a-rate";
  };
  /** Audio I/O spec for dac~/adc~ — declared on the compiled processor. */
  ioSpec?: {
    direction: "in" | "out";
    channels: number;
    name: string;
  };
};
