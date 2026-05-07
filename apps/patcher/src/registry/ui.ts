// UI objects that emit a control value via a param() declaration on the
// compiled processor. The build() bodies are no-ops because the compiler
// special-cases paramSpec nodes; the registered build() is here so the
// shape matches NodeDef.

import type { Node as UNode } from "@unworklet/core";
import type { NodeDef } from "../types";
import { register } from "./store";

function makeKnob(
  type: string,
  description: string,
  defaultMin: number,
  defaultMax: number,
  defaultVal: number,
  component: string,
): NodeDef {
  return {
    type,
    category: "ui",
    description,
    inlets: [],
    outlets: [{ kind: "control", label: "value" }],
    attrs: [
      { name: "min", kind: "number", default: defaultMin },
      { name: "max", kind: "number", default: defaultMax },
      { name: "value", kind: "number", default: defaultVal, min: defaultMin, max: defaultMax },
      { name: "label", kind: "string", default: "" },
    ],
    paramSpec: {
      name: "value",
      default: defaultVal,
      min: defaultMin,
      max: defaultMax,
      automationRate: "k-rate",
    },
    build: () => [],
    component,
  };
}

register(
  makeKnob("slider", "Horizontal slider.", 0, 1, 0.5, "SliderView"),
  makeKnob("vslider", "Vertical slider.", 0, 1, 0.5, "VSliderView"),
  makeKnob("dial", "Rotary dial / knob.", 0, 1, 0.5, "DialView"),
  makeKnob("number-box", "Editable number box.", -1e6, 1e6, 0, "NumberBoxView"),
  makeKnob("flonum", "Editable float number box.", -1e6, 1e6, 0, "NumberBoxView"),
  // live.dial / live.slider — same as dial/slider but a different visual style.
  makeKnob("live.dial", "Ableton-Live-style dial.", 0, 1, 0.5, "LiveDialView"),
  makeKnob("live.slider", "Ableton-Live-style slider.", 0, 1, 0.5, "LiveSliderView"),
);

// button (Max bang) — emits 1 momentarily on click; default value 0.
register({
  type: "button",
  category: "ui",
  description: "Bang. Click to emit 1 (decays to 0 in ~30 ms).",
  inlets: [],
  outlets: [{ kind: "control", label: "bang" }],
  attrs: [{ name: "label", kind: "string", default: "" }],
  paramSpec: {
    name: "value",
    default: 0,
    min: 0,
    max: 1,
    automationRate: "k-rate",
  },
  build: () => [],
  component: "ButtonView",
});

// toggle — sticky 0/1.
register({
  type: "toggle",
  category: "ui",
  description: "Toggle (0 or 1, click to flip).",
  inlets: [],
  outlets: [{ kind: "control", label: "value" }],
  attrs: [
    { name: "value", kind: "number", default: 0, min: 0, max: 1 },
    { name: "label", kind: "string", default: "" },
  ],
  paramSpec: {
    name: "value",
    default: 0,
    min: 0,
    max: 1,
    automationRate: "k-rate",
  },
  build: () => [],
  component: "ToggleView",
});

// kslider — mini piano keyboard. Click a key → emits MIDI note (0..127) on
// outlet 0 and gate (0/1) on outlet 1. Implemented as two AudioParams.
register({
  type: "kslider",
  category: "ui",
  description: "Mini piano keyboard. Outlets: note (0..127), gate (0/1).",
  inlets: [],
  outlets: [
    { kind: "control", label: "note" },
    { kind: "control", label: "gate" },
  ],
  attrs: [
    { name: "octaves", kind: "number", default: 2, min: 1, max: 4 },
    { name: "lowNote", kind: "number", default: 48 },
  ],
  // kslider is special: two paramSpecs. Compiler handles 1 paramSpec; for
  // kslider we use a custom builder that declares two params.
  build: () => [],
  component: "KsliderView",
});

// comment — text label, no I/O.
register({
  type: "comment",
  category: "ui",
  description: "Free-text comment. No audio / control.",
  inlets: [],
  outlets: [],
  attrs: [{ name: "text", kind: "string", default: "comment" }],
  build: () => [],
  component: "CommentView",
});

// multislider — N stacked sliders, outputs a constant. Useful for sequence
// patterns — combined with `counter` + `selector~` you have a step seq.
register({
  type: "multislider",
  category: "ui",
  description: "Bank of N sliders. Use with index-based selection.",
  inlets: [{ kind: "control", label: "idx" }],
  outlets: [{ kind: "control", label: "value" }],
  attrs: [
    { name: "count", kind: "number", default: 8, min: 1, max: 32 },
    { name: "min", kind: "number", default: 0 },
    { name: "max", kind: "number", default: 1 },
    { name: "values", kind: "string", default: "[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]" },
  ],
  build: () => [],
  component: "MultisliderView",
});

// umenu — drop-down enum. Selected index → control.
register({
  type: "umenu",
  category: "ui",
  description: "Dropdown menu. Selected index → control outlet.",
  inlets: [],
  outlets: [{ kind: "control", label: "idx" }],
  attrs: [
    { name: "options", kind: "string", default: "[\"option 1\",\"option 2\"]" },
    { name: "value", kind: "number", default: 0 },
  ],
  paramSpec: {
    name: "value",
    default: 0,
    min: 0,
    max: 16,
    automationRate: "k-rate",
  },
  build: () => [],
  component: "UMenuView",
});
