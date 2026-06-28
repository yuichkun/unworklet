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
const lp = instantiate(onepole, f32(0.15), { name: "lp" });
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

test("replaying a snapshot actually lowers the sugar (not a silent identity pass-through)", () => {
  // The browser bug was that type-directed lowering silently degraded to a no-op
  // off-disk: `out.left[i] = v` stayed raw, so the captured graph had an empty
  // process body and the WASM was a silent stub. Pin that the off-disk lowering
  // resolves `@unworklet/core`'s types and rewrites the index-write + operators.
  const offDisk = lower(DISTORTION, { snapshot: captureFsSnapshot() });
  expect(offDisk).toContain(".at(");
  expect(offDisk).toContain(".write(");
  expect(offDisk).toContain("mul(");
  expect(offDisk).not.toMatch(/out\.left\[/); // the raw index-write must be gone
});

test("replay binds the program to the SNAPSHOT's record directory, not the live one", () => {
  // Module resolution starts from the entry file's directory; every recorded host
  // answer is keyed off it. The snapshot must therefore carry that directory and
  // replay must use it — otherwise an environment whose live directory differs
  // (the browser, where `import.meta.dirname` is undefined → `/__uwk__`) resolves
  // against keys the snapshot never recorded and lowering degrades to a no-op.
  const snapshot = captureFsSnapshot();
  expect(typeof snapshot.selfDir).toBe("string");
  expect(snapshot.selfDir.length).toBeGreaterThan(0);
  // Resolution keys are derived from selfDir, so it must be a prefix of the
  // recorded paths (the entry's node_modules walk starts there).
  const someRecordedKey = Object.keys(snapshot.sourceTexts).find((k) =>
    k.includes("@unworklet/core"),
  );
  expect(someRecordedKey).toBeTruthy();
});
