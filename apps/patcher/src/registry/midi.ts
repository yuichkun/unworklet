// MIDI nodes. We declare them as paramSpec-emitting nodes so MIDI events
// land via main-thread param writes (the runtime listens to Web MIDI and
// pokes the param values). For audio-rate MIDI feedback we'd need to wire
// up the unworklet midiInput primitive — keep that as a stretch.

import type { NodeDef } from "../types";
import { register } from "./store";

// notein — MIDI note input. Outlets: note (0..127), velocity, gate.
register({
  type: "notein",
  category: "midi",
  description: "MIDI note input. Outlets: note (0..127), velocity (0..127), gate.",
  inlets: [],
  outlets: [
    { kind: "control", label: "note" },
    { kind: "control", label: "vel" },
    { kind: "control", label: "gate" },
  ],
  attrs: [{ name: "channel", kind: "number", default: 0, min: -1, max: 15 }],
  build: () => [],
  // Special: the compiler treats notein as 3 separate paramSpec-style outlets;
  // implementation lives in compile.ts as a fallback (declares 3 params).
  paramSpec: {
    name: "value",
    default: 60,
    min: 0,
    max: 127,
    automationRate: "k-rate",
  },
});

// noteout — MIDI note output. Inlets: note, vel, gate. Stub for now (UI-only).
register({
  type: "noteout",
  category: "midi",
  description: "MIDI note output. Sends notes via Web MIDI on user gesture.",
  inlets: [
    { kind: "control", label: "note" },
    { kind: "control", label: "vel" },
    { kind: "control", label: "gate" },
  ],
  outlets: [],
  build: () => [],
});

// ctlin — MIDI CC input. Single value (CC number set as attr).
register({
  type: "ctlin",
  category: "midi",
  description: "MIDI CC input. Outlet: CC value (0..127).",
  inlets: [],
  outlets: [{ kind: "control", label: "value" }],
  attrs: [
    { name: "controller", kind: "number", default: 1 },
    { name: "channel", kind: "number", default: 0, min: -1, max: 15 },
  ],
  paramSpec: {
    name: "value",
    default: 0,
    min: 0,
    max: 127,
    automationRate: "k-rate",
  },
  build: () => [],
});

// ctlout — emit MIDI CC. Stub for now.
register({
  type: "ctlout",
  category: "midi",
  description: "MIDI CC output (stub).",
  inlets: [{ kind: "control", label: "value" }],
  outlets: [],
  attrs: [
    { name: "controller", kind: "number", default: 1 },
    { name: "channel", kind: "number", default: 0, min: -1, max: 15 },
  ],
  build: () => [],
});

// pitchbend — MIDI pitch wheel. Outlet: -1..+1.
register({
  type: "pitchbend",
  category: "midi",
  description: "MIDI pitch bend. Outlet: -1..+1.",
  inlets: [],
  outlets: [{ kind: "control", label: "value" }],
  paramSpec: {
    name: "value",
    default: 0,
    min: -1,
    max: 1,
    automationRate: "k-rate",
  },
  build: () => [],
});

// midiin / midiout — pass-through stubs. The "raw" MIDI bus version isn't
// wired through unworklet's midiInput primitive in this initial PR; users
// with serious MIDI workflows should patch via notein/ctlin/pitchbend.
register({
  type: "midiin",
  category: "midi",
  description: "Raw MIDI input (stub — use notein/ctlin/pitchbend for now).",
  inlets: [],
  outlets: [{ kind: "control", label: "midi" }],
  build: () => [],
});
register({
  type: "midiout",
  category: "midi",
  description: "Raw MIDI output (stub).",
  inlets: [{ kind: "control", label: "midi" }],
  outlets: [],
  build: () => [],
});
