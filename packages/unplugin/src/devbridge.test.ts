import { expect, test } from "vite-plus/test";

import {
  appendBounded,
  type DevSlotType,
  downsampleTo,
  drainInjects,
  foldProxyGraph,
  frameLevels,
  normalizeFreqDb,
  type RawSlot,
  slotMemory,
  splitSlots,
  toLoggableMidiEvent,
  toSendableMidiEvent,
} from "./devbridge.ts";

// ── byte builders (black-box: construct the raw LE bytes devDump would return) ──

const scalarBytes = (type: DevSlotType, value: number | bigint | boolean): Uint8Array => {
  const buf = new ArrayBuffer(type === "f64" || type === "i64" ? 8 : 4);
  const dv = new DataView(buf);
  if (type === "f32") dv.setFloat32(0, value as number, true);
  else if (type === "f64") dv.setFloat64(0, value as number, true);
  else if (type === "i32") dv.setInt32(0, value as number, true);
  else if (type === "i64") dv.setBigInt64(0, value as bigint, true);
  else if (type === "bool") dv.setInt32(0, value ? 1 : 0, true);
  return new Uint8Array(buf);
};
const f32BufferBytes = (vals: number[]): Uint8Array =>
  new Uint8Array(Float32Array.from(vals).buffer);
const u8BufferBytes = (vals: number[]): Uint8Array => Uint8Array.from(vals);

const scalar = (
  name: string,
  kind: "state" | "param",
  type: DevSlotType,
  value: number | bigint | boolean,
): RawSlot => ({ name, kind, type, data: scalarBytes(type, value) });

// ── splitSlots ────────────────────────────────────────────────────────────--

test("splitSlots: decodes scalar state + param values by type", () => {
  // f32-exact values (0.5 / 0.25) so the byte round-trip equals exactly.
  const { scalars } = splitSlots(
    [
      scalar("meter", "state", "f32", 0.5),
      scalar("note", "state", "i32", 69),
      scalar("gate", "state", "bool", true),
      scalar("mix", "param", "f32", 0.25),
    ],
    512,
  );
  expect(scalars).toEqual([
    { name: "meter", kind: "state", type: "f32", value: 0.5 },
    { name: "note", kind: "state", type: "i32", value: 69 },
    { name: "gate", kind: "state", type: "bool", value: true },
    { name: "mix", kind: "param", type: "f32", value: 0.25 },
  ]);
});

test("splitSlots: i64 is decoded to a decimal STRING (JSON has no bigint)", () => {
  const { scalars } = splitSlots([scalar("count", "state", "i64", 3632896n)], 512);
  expect(scalars[0]!.value).toBe("3632896");
  expect(typeof scalars[0]!.value).toBe("string");
});

test("splitSlots: a small buffer is sent in full, not downsampled", () => {
  const { buffers } = splitSlots(
    [{ name: "pattern", kind: "buffer", type: "u8", data: u8BufferBytes([10, 20, 30, 40]) }],
    512,
  );
  expect(buffers[0]).toEqual({
    name: "pattern",
    type: "u8",
    length: 4,
    data: [10, 20, 30, 40],
    downsampled: false,
  });
});

test("splitSlots: a buffer larger than maxBufferPoints is stride-downsampled; length stays true", () => {
  const full = Array.from({ length: 2048 }, (_, i) => i);
  const { buffers } = splitSlots(
    [{ name: "delayLine", kind: "buffer", type: "f32", data: f32BufferBytes(full) }],
    512,
  );
  const b = buffers[0]!;
  expect(b.length).toBe(2048); // true element count preserved
  expect(b.downsampled).toBe(true);
  expect(b.data.length).toBe(512); // reduced for the wire
  expect(b.data[0]).toBe(0); // stride sampling: 0, 4, 8, …
  expect(b.data[1]).toBe(4);
});

test("splitSlots: scalars and buffers are split into the right buckets", () => {
  const { scalars, buffers } = splitSlots(
    [
      scalar("x", "state", "f32", 1),
      { name: "buf", kind: "buffer", type: "u8", data: u8BufferBytes([1, 2]) },
    ],
    512,
  );
  expect(scalars.map((s) => s.name)).toEqual(["x"]);
  expect(buffers.map((b) => b.name)).toEqual(["buf"]);
});

// ── foldProxyGraph ────────────────────────────────────────────────────────--

type N = { id: string; label: string };
const n = (id: string): N => ({ id, label: id });

test("foldProxyGraph: with no proxies, passes nodes through and dedupes edges", () => {
  const out = foldProxyGraph(
    [n("a"), n("b")],
    [
      { from: "a", to: "b" },
      { from: "a", to: "b" }, // duplicate
    ],
    {},
  );
  expect(out.nodes.map((x) => x.id)).toEqual(["a", "b"]);
  expect(out.edges).toEqual([{ id: "a>b", from: "a", to: "b" }]);
});

test("foldProxyGraph: folds an input proxy out — edge into proxy becomes edge into its owner", () => {
  // app wrote mix → tape; createNode inserted tapeProxy: mix → tapeProxy, tapeProxy → tape.
  const out = foldProxyGraph(
    [n("mix"), n("tape"), n("tapeProxy")],
    [
      { from: "mix", to: "tapeProxy" },
      { from: "tapeProxy", to: "tape" },
    ],
    { tapeProxy: "tape" },
  );
  expect(out.nodes.map((x) => x.id)).toEqual(["mix", "tape"]); // proxy dropped from nodes
  expect(out.edges).toEqual([{ id: "mix>tape", from: "mix", to: "tape" }]); // folded; internal edge gone
});

test("foldProxyGraph: a chain through two proxies folds to direct edges, no self-loops", () => {
  // mix → tapeProxy → tape → crushProxy → crush
  const out = foldProxyGraph(
    [n("mix"), n("tape"), n("crush"), n("tapeProxy"), n("crushProxy")],
    [
      { from: "mix", to: "tapeProxy" },
      { from: "tapeProxy", to: "tape" },
      { from: "tape", to: "crushProxy" },
      { from: "crushProxy", to: "crush" },
    ],
    { tapeProxy: "tape", crushProxy: "crush" },
  );
  expect(out.nodes.map((x) => x.id)).toEqual(["mix", "tape", "crush"]);
  expect(out.edges).toEqual([
    { id: "mix>tape", from: "mix", to: "tape" },
    { id: "tape>crush", from: "tape", to: "crush" },
  ]);
});

test("foldProxyGraph: keeps an authored feedback self-loop (node → its own input proxy)", () => {
  // app wrote delay.connect(delay.inputs.fb) — a valid Web-Audio feedback loop.
  // captured: delay → delayFb (authored output → own input proxy) and the internal
  // delayFb → delay (the proxy forwarding into the worklet). Folding the input
  // proxy out turns the authored edge into delay → delay, which must SURVIVE so the
  // panel shows the loop rather than hiding it. (Reported by @codex on #12.)
  const out = foldProxyGraph(
    [n("delay"), n("delayFb")],
    [
      { from: "delay", to: "delayFb" },
      { from: "delayFb", to: "delay" },
    ],
    { delayFb: "delay" },
  );
  expect(out.nodes.map((x) => x.id)).toEqual(["delay"]); // proxy folded out of nodes
  expect(out.edges).toEqual([{ id: "delay>delay", from: "delay", to: "delay" }]); // feedback kept
});

// ── frameLevels ─────────────────────────────────────────────────────────────

test("frameLevels: rms + absolute peak over a time frame", () => {
  // [-1, 1, -1, 1] → rms = 1, peak = 1.
  expect(frameLevels([-1, 1, -1, 1])).toEqual({ rms: 1, peak: 1 });
  // DC at 0.5 → rms = 0.5, peak = 0.5.
  expect(frameLevels([0.5, 0.5, 0.5, 0.5])).toEqual({ rms: 0.5, peak: 0.5 });
  // peak tracks the largest magnitude regardless of sign.
  expect(frameLevels([0, -0.8, 0.2]).peak).toBeCloseTo(0.8, 6);
});

test("frameLevels: empty frame is silent, not NaN", () => {
  expect(frameLevels([])).toEqual({ rms: 0, peak: 0 });
});

// ── downsampleTo ────────────────────────────────────────────────────────────

test("downsampleTo: frames at/under the target pass through unchanged", () => {
  expect(downsampleTo([1, 2, 3], 4)).toEqual([1, 2, 3]);
  expect(downsampleTo([1, 2, 3], 3)).toEqual([1, 2, 3]);
});

test("downsampleTo: stride-decimates a longer frame to the target length", () => {
  const src = Array.from({ length: 100 }, (_, i) => i);
  const out = downsampleTo(src, 10);
  expect(out).toHaveLength(10);
  // stride = 10 → first picks are 0, 10, 20, ...
  expect(out[0]).toBe(0);
  expect(out[1]).toBe(10);
  expect(out[9]).toBe(90);
});

test("downsampleTo: zero points yields an empty frame", () => {
  expect(downsampleTo([1, 2, 3], 0)).toEqual([]);
});

// ── normalizeFreqDb ─────────────────────────────────────────────────────────

test("normalizeFreqDb: maps dB into 0..1 over [minDb, maxDb] and clamps", () => {
  // minDb=-100, maxDb=-30, span=70. -65 dB → (−65 − −100)/70 = 0.5.
  const out = normalizeFreqDb([-30, -65, -100, -140, 0], 5, -100, -30);
  expect(out[0]).toBeCloseTo(1, 6); // -30 → top
  expect(out[1]).toBeCloseTo(0.5, 6); // -65 → mid
  expect(out[2]).toBeCloseTo(0, 6); // -100 → floor
  expect(out[3]).toBe(0); // -140 clamps to 0
  expect(out[4]).toBe(1); // 0 dB clamps to 1
});

// ── slotMemory ──────────────────────────────────────────────────────────────

test("slotMemory: bytes per slot come from the real dumped byte length", () => {
  const slots: RawSlot[] = [
    { name: "phase", kind: "state", type: "f32", data: scalarBytes("f32", 0.5) }, // 4 B
    { name: "count", kind: "state", type: "i64", data: scalarBytes("i64", 7n) }, // 8 B
    { name: "delayLine", kind: "buffer", type: "f32", data: f32BufferBytes([0, 0, 0, 0]) }, // 16 B
    { name: "pattern", kind: "buffer", type: "u8", data: u8BufferBytes([1, 2, 3]) }, // 3 B
  ];
  const { entries, totalBytes } = slotMemory(slots);
  expect(entries).toEqual([
    { name: "phase", kind: "state", bytes: 4 },
    { name: "count", kind: "state", bytes: 8 },
    { name: "delayLine", kind: "buffer", bytes: 16 },
    { name: "pattern", kind: "buffer", bytes: 3 },
  ]);
  expect(totalBytes).toBe(31);
});

// ── appendBounded ───────────────────────────────────────────────────────────

test("appendBounded: appends below the cap, drops the oldest at the cap", () => {
  expect(appendBounded([1, 2], 3, 5)).toEqual([1, 2, 3]);
  // At the cap (3): appending 4 drops the oldest (1).
  expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  // An already-oversized list collapses to the newest `max` items.
  expect(appendBounded([1, 2, 3, 4, 5], 6, 3)).toEqual([4, 5, 6]);
});

// ── drainInjects ────────────────────────────────────────────────────────────

test("drainInjects: returns only commands newer than lastSeq, in seq order", () => {
  const cmds = [
    { seq: 3, note: "c" },
    { seq: 1, note: "a" },
    { seq: 2, note: "b" },
  ];
  const out = drainInjects(cmds, 0);
  expect(out.fresh.map((c) => c.note)).toEqual(["a", "b", "c"]);
  expect(out.lastSeq).toBe(3);
});

test("drainInjects: a trailing noteOff in the same burst is never dropped", () => {
  // noteOn (seq 5) then noteOff (seq 6) both land before the next drain.
  const cmds = [
    { seq: 5, kind: "noteOn" },
    { seq: 6, kind: "noteOff" },
  ];
  const out = drainInjects(cmds, 4);
  expect(out.fresh.map((c) => c.kind)).toEqual(["noteOn", "noteOff"]);
  expect(out.lastSeq).toBe(6);
});

test("drainInjects: nothing new leaves lastSeq untouched", () => {
  const out = drainInjects([{ seq: 2 }, { seq: 1 }], 2);
  expect(out.fresh).toEqual([]);
  expect(out.lastSeq).toBe(2);
});

test("toSendableMidiEvent: passes non-sysex events through unchanged", () => {
  const noteOn = { type: "noteOn", channel: 0, note: 60, velocity: 100 };
  expect(toSendableMidiEvent(noteOn)).toBe(noteOn);
});

test("toSendableMidiEvent: converts a sysex number[] payload to Uint8Array (send() expects typed data)", () => {
  const out = toSendableMidiEvent({ type: "sysex", data: [0xf0, 0x7e, 0x01, 0xf7] });
  expect(out).not.toBeNull();
  const data = out!.data;
  expect(data).toBeInstanceOf(Uint8Array);
  expect(Array.from(data as Uint8Array)).toEqual([0xf0, 0x7e, 0x01, 0xf7]);
});

test("toSendableMidiEvent: rejects malformed sysex bytes instead of silently wrapping mod 256", () => {
  // Uint8Array.from(300) would silently become 44 — a different message.
  expect(toSendableMidiEvent({ type: "sysex", data: [0xf0, 300, 0xf7] })).toBeNull();
  expect(toSendableMidiEvent({ type: "sysex", data: [0xf0, -1, 0xf7] })).toBeNull();
  expect(toSendableMidiEvent({ type: "sysex", data: [0xf0, 1.5, 0xf7] })).toBeNull();
  expect(toSendableMidiEvent({ type: "sysex", data: "f07ef7" })).toBeNull();
});

test("toSendableMidiEvent: accepts sysex data already carried as a Uint8Array", () => {
  const data = new Uint8Array([0xf0, 0x7e, 0xf7]);
  const out = toSendableMidiEvent({ type: "sysex", data });
  expect(out!.data).toBe(data);
});

test("toLoggableMidiEvent: renders sysex bytes as a plain array (the DevMidiEvent wire shape)", () => {
  // The MIDI log crosses the RPC boundary, where a Uint8Array serializes as an
  // indexed object rather than the `data: number[]` the panel contract states.
  const out = toLoggableMidiEvent({ type: "sysex", data: new Uint8Array([0xf0, 0x7e, 0xf7]) });
  expect(Array.isArray(out.data)).toBe(true);
  expect(out.data).toEqual([0xf0, 0x7e, 0xf7]);
});

test("toLoggableMidiEvent: leaves an already-plain sysex payload as an array", () => {
  const out = toLoggableMidiEvent({ type: "sysex", data: [0xf0, 0x01, 0xf7] });
  expect(out.data).toEqual([0xf0, 0x01, 0xf7]);
});

test("toLoggableMidiEvent: passes non-sysex events through unchanged", () => {
  const noteOn = { type: "noteOn", channel: 0, note: 60, velocity: 100 };
  expect(toLoggableMidiEvent(noteOn)).toBe(noteOn);
});
