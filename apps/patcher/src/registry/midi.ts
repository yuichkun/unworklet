// MIDI nodes. We declare them with paramSpecs[] (one AudioParam per outlet)
// so the runtime can poke each outlet independently. The runtime opens
// Web MIDI and routes incoming events into the matching params; output
// nodes capture their inlet samples back to JS via main-thread polling
// against the live AudioParam value, then forward to MIDIOutputs.

import type { NodeDef } from "../types";
import { register } from "./store";

// notein — MIDI note input.
//   outlet 0 = note (0..127, k-rate)
//   outlet 1 = velocity (0..1)
//   outlet 2 = gate (0/1)
register({
  type: "notein",
  category: "midi",
  description: "MIDI note input. Outlets: note (0..127), velocity (0..1), gate (0/1).",
  inlets: [],
  outlets: [
    { kind: "control", label: "note" },
    { kind: "control", label: "vel" },
    { kind: "control", label: "gate" },
  ],
  attrs: [{ name: "channel", kind: "number", default: 0, min: 0, max: 16 }],
  defaultAttrs: { channel: 0 },
  paramSpecs: [
    { name: "note", default: 60, min: 0, max: 127, automationRate: "k-rate", outletIndex: 0 },
    { name: "vel", default: 0, min: 0, max: 1, automationRate: "k-rate", outletIndex: 1 },
    { name: "gate", default: 0, min: 0, max: 1, automationRate: "k-rate", outletIndex: 2 },
  ],
  midiSpec: { direction: "in", kind: "note" },
  build: () => [],
});

// noteout — MIDI note output. We publish each inlet to a state slot at
// 120 fps so the main-thread runtime can detect gate transitions and emit
// MIDI note-on / note-off via every connected MIDIOutput. (~8 ms latency,
// acceptable for a live patcher.)
register({
  type: "noteout",
  category: "midi",
  description: "MIDI note output — sends to every connected MIDIOutput on gate transition.",
  inlets: [
    { kind: "control", label: "note" },
    { kind: "control", label: "vel" },
    { kind: "control", label: "gate" },
  ],
  outlets: [],
  midiSpec: { direction: "out", kind: "note" },
  build: (ctx, _args, _attrs) => {
    const note = ctx.inControl(0, 60);
    const vel = ctx.inControl(1, 0.5);
    const gate = ctx.inControl(2, 0);
    const sNote = ctx.state.f32(60, { name: `noteout_${ctx.id}_note`, publish: { rateFps: 120 } });
    const sVel = ctx.state.f32(0.5, { name: `noteout_${ctx.id}_vel`, publish: { rateFps: 120 } });
    const sGate = ctx.state.f32(0, { name: `noteout_${ctx.id}_gate`, publish: { rateFps: 120 } });
    sNote.store(note);
    sVel.store(vel);
    sGate.store(gate);
    return [];
  },
});

// ctlin — MIDI CC input. Outlet 0 = value normalized 0..1.
register({
  type: "ctlin",
  category: "midi",
  description: "MIDI CC input. Outlet 0 = normalized value (0..1).",
  inlets: [],
  outlets: [{ kind: "control", label: "value" }],
  attrs: [
    { name: "controller", kind: "number", default: 1, min: 0, max: 127 },
    { name: "channel", kind: "number", default: 0, min: 0, max: 16 },
  ],
  defaultAttrs: { controller: 1, channel: 0 },
  paramSpecs: [
    { name: "value", default: 0, min: 0, max: 1, automationRate: "k-rate", outletIndex: 0 },
  ],
  midiSpec: { direction: "in", kind: "cc" },
  build: () => [],
});

// ctlout — MIDI CC output. Publishes inlet 0 at 60 fps; runtime forwards
// CC messages with deduplication (only sends when the value changes by ≥ 1/127).
register({
  type: "ctlout",
  category: "midi",
  description: "MIDI CC output. Forwards inlet 0 (0..1) as CC value.",
  inlets: [{ kind: "control", label: "value" }],
  outlets: [],
  attrs: [
    { name: "controller", kind: "number", default: 1, min: 0, max: 127 },
    { name: "channel", kind: "number", default: 0, min: 0, max: 16 },
  ],
  defaultAttrs: { controller: 1, channel: 0 },
  midiSpec: { direction: "out", kind: "cc" },
  build: (ctx, _args, _attrs) => {
    const v = ctx.inControl(0, 0);
    const s = ctx.state.f32(0, { name: `ctlout_${ctx.id}_v`, publish: { rateFps: 60 } });
    s.store(v);
    return [];
  },
});

// pitchbend — MIDI pitch wheel. Outlet 0 = -1..+1.
register({
  type: "pitchbend",
  category: "midi",
  description: "MIDI pitch bend. Outlet 0 = -1..+1.",
  inlets: [],
  outlets: [{ kind: "control", label: "value" }],
  attrs: [{ name: "channel", kind: "number", default: 0, min: 0, max: 16 }],
  paramSpecs: [
    { name: "value", default: 0, min: -1, max: 1, automationRate: "k-rate", outletIndex: 0 },
  ],
  midiSpec: { direction: "in", kind: "pitchbend" },
  build: () => [],
});

// midiin — raw MIDI passthrough input (any-event). Emits the *running status*
// byte on outlet 0 so simple `route` patches can branch by event type.
register({
  type: "midiin",
  category: "midi",
  description: "Raw MIDI input — outlet 0 emits running-status byte (0x90/0xB0/...).",
  inlets: [],
  outlets: [{ kind: "control", label: "status" }],
  paramSpecs: [
    { name: "status", default: 0, min: 0, max: 255, automationRate: "k-rate", outletIndex: 0 },
  ],
  midiSpec: { direction: "in", kind: "cc" }, // approximation: any CC bumps the status
  build: () => [],
});

// midiout — raw MIDI output passthrough. Forwards status byte from inlet 0
// to every connected MIDIOutput when it changes (deduplicated).
register({
  type: "midiout",
  category: "midi",
  description: "Raw MIDI output — forwards inlet 0 as a single byte to every MIDIOutput.",
  inlets: [{ kind: "control", label: "status" }],
  outlets: [],
  midiSpec: { direction: "out", kind: "raw" },
  build: (ctx, _args, _attrs) => {
    const v = ctx.inControl(0, 0);
    const s = ctx.state.f32(0, { name: `midiout_${ctx.id}_b`, publish: { rateFps: 60 } });
    s.store(v);
    return [];
  },
});
