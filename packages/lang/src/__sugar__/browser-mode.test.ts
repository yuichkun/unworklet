/**
 * `lower()` must run off-disk — no `node:*`, no `ts.sys` — so the live editor can
 * recompile `.uwk.ts` in the browser. The contract: a file-system snapshot
 * captured once in Node (`captureFsSnapshot`) replays the EXACT type-directed
 * lowering for any input. These cases cover the type-sensitive sugar paths
 * (operator dispatch, index access, `?:`, `$prev` slot type, bare-state read,
 * `event.midi` handlers) so a regression in the off-disk type environment shows
 * up as a lowering divergence here, not as silently-wrong audio in the browser.
 */
import { expect, test } from "vite-plus/test";

import { captureFsSnapshot } from "../capture.ts";
import { lower } from "../lower.ts";

const DISTORTION = `
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();
process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    const r = input.right[i] * drive[i];
    out.left[i]  = l > 1 ? 1 : l < -1 ? -1 : l;
    out.right[i] = r > 1 ? 1 : r < -1 ? -1 : r;
  });
});`;

const LOWPASS = `
const input = audioInput({ channels: 1, name: "main" });
const out   = audioOutput({ channels: 1, name: "main" });
const onepole = defineSubgraph((k: Node<"f32">) => ({
  process: (x: Node<"f32">) => k * x + (1 - k) * $prev,
}));
const lp = createSubgraph(onepole, f32(0.15), { name: "lp" });
process(() => {
  forSample((i) => {
    out.ch(0)[i] = lp.process(input.ch(0)[i]);
  });
});`;

const SYNTH = `
const out  = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });
const hz    = state.f32(440).named();
const gate  = state.f32(0).named();
const phase = state.f32(0).named();
process(() => {
  keys.onEvent("noteOn", ({ note }) => {
    hz.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440);
    gate.write(1);
  });
  keys.onEvent("noteOff", () => gate.write(0));
  forSample((i) => {
    phase.write((phase + hz / 48000) % 1);
    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * gate * 0.2;
  });
});`;

const CASES = { DISTORTION, LOWPASS, SYNTH };

test("a captured snapshot lowers identically to disk for every type-sensitive case", () => {
  const snapshot = captureFsSnapshot();
  for (const [name, src] of Object.entries(CASES)) {
    const onDisk = lower(src);
    const offDisk = lower(src, { snapshot });
    expect(offDisk, `off-disk lowering must match disk for ${name}`).toBe(onDisk);
  }
});

test("the snapshot is JSON-serializable (shippable to the browser) and still lowers identically", () => {
  const snapshot = captureFsSnapshot();
  const roundTripped = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  expect(lower(SYNTH, { snapshot: roundTripped })).toBe(lower(SYNTH));
});
