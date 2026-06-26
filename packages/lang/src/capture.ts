/**
 * Capture the file-system snapshot that lets `lower()` run off-disk (= in the
 * browser, for the live editor). The `.uwk.ts` input imports nothing, so the only
 * thing the type-directed program resolves is the ambient → `@unworklet/core` →
 * lib graph — identical for every input. But the ambient pulls core's types
 * through LAZY `import("@unworklet/core").X` type queries: a file is only read
 * once a lowering pass actually queries a type that needs it. So the snapshot
 * must be captured by RUNNING `lower()` over probes that exercise every
 * type-sensitive surface (operators, index, `?:`, `$prev`, every MIDI event
 * shape, `event<T>`, buffers), merging the reads. Each probe runs under a
 * try/catch — even a probe that fails to lower has already recorded the reads it
 * triggered, so coverage only grows.
 *
 * Run this once in Node (e.g. at the demo's build step), ship the JSON to the
 * browser, and pass it to `lower(src, { snapshot })`.
 */
import { lower } from "./lower.ts";
import { emptySnapshot, type FsSnapshot } from "./program.ts";

const PROBES: string[] = [
  // operators + index + `?:` + param
  `
const input = audioInput({ channels: 2, name: "main" });
const out   = audioOutput({ channels: 2, name: "main" });
const drive = param.f32({ default: 4, min: 1, max: 20, automationRate: "a-rate" }).named();
process(() => {
  forSample((i) => {
    const l = input.left[i] * drive[i];
    out.left[i]  = l > 1 ? 1 : l < -1 ? -1 : l;
    out.right[i] = input.right[i] * drive[i];
  });
});`,
  // $prev + defineSubgraph + instantiate
  `
const input = audioInput({ channels: 1, name: "main" });
const out   = audioOutput({ channels: 1, name: "main" });
const onepole = defineSubgraph((k: Node<"f32">) => ({
  process: (x: Node<"f32">) => k * x + (1 - k) * $prev,
}));
const lp = instantiate(onepole, f32(0.15), { name: "lp" });
process(() => { forSample((i) => { out.ch(0)[i] = lp.process(input.ch(0)[i]); }); });`,
  // every inbound MIDI event shape + state + bare-state read + math
  `
const out  = audioOutput({ channels: 1, name: "main" });
const keys = event.midi({ from: "main", name: "keys" });
const s    = state.f32(0).named();
const ph   = state.f32(0).named();
process(() => {
  keys.onEvent("noteOn", ({ note, velocity, channel }) => { s.write(exp(f32(note - 69) * (Math.LN2 / 12)) * 440); });
  keys.onEvent("noteOff", ({ note }) => { s.write(0); });
  keys.onEvent("cc", ({ controller, value }) => { s.write(f32(value)); });
  keys.onEvent("pitchBend", ({ value }) => { s.write(f32(value)); });
  keys.onEvent("programChange", ({ program }) => { s.write(f32(program)); });
  keys.onEvent("channelPressure", ({ pressure }) => { s.write(f32(pressure)); });
  keys.onEvent("aftertouch", ({ note, pressure }) => { s.write(f32(pressure)); });
  keys.onEvent("systemRealtime", ({ status }) => { s.write(f32(status)); });
  forSample((i) => { ph.write((ph + s / 48000) % 1); out.ch(0)[i] = sin(ph * (Math.PI * 2)) * 0.2; });
});`,
  // outbound MIDI emit
  `
const out = audioOutput({ channels: 1, name: "main" });
const mo  = event.midi({ to: "main", name: "mo" });
const trig = state.bool(false).named();
process(() => {
  forSample((i) => {
    mo.emitIf(trig, { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: i });
    out.ch(0)[i] = f32(0);
  });
});`,
  // typed event<T> in + out
  `
const out  = audioOutput({ channels: 1, name: "main" });
const ping = event<{ go: number }>({ from: "main", name: "ping" });
const peak = event<{ level: number }>({ to: "main", name: "peak" });
const lvl  = state.f32(0).named();
process(() => {
  ping.onReceive(({ go }) => { lvl.write(f32(go)); });
  forSample((i) => { out.ch(0)[i] = lvl; peak.emitIf(lvl > 0.5, { level: lvl }); });
});`,
  // buffers (index read/write + interpolated)
  `
const input = audioInput({ channels: 1, name: "main" });
const out   = audioOutput({ channels: 1, name: "main" });
const buf   = state.buffer.f32({ size: 128 }).named();
const w     = state.i32(0).named();
process(() => {
  forSample((i) => {
    buf[w] = input.ch(0)[i];
    out.ch(0)[i] = buf[i];
    w.write((w + 1) % 128);
  });
});`,
];

export function captureFsSnapshot(probes: string[] = PROBES): FsSnapshot {
  const record = emptySnapshot();
  for (const probe of probes) {
    try {
      lower(probe, { captureInto: record });
    } catch {
      // A probe that fails to lower has still recorded the reads it triggered;
      // coverage only grows, so ignore the failure and keep merging.
    }
  }
  return record;
}
