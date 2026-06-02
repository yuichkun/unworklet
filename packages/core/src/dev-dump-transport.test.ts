/**
 * Worklet-side dev-dump (DevTools X-ray) against a REAL compiled WASM module.
 *
 * Unlike `snapshot-request` (which captures only userNamed + persistent slots),
 * `dev-dump-request` returns EVERY state / buffer / param — named or anonymous,
 * persistent or transient — so the devtools panel can X-ray a processor's whole
 * live memory. It travels as a postMessage request/response handled in the
 * worklet's port listener, which runs at the render-quantum boundary, so reading
 * linear memory there is block-atomic by construction (`06-runtime.md` §6.1).
 *
 * The oracle is "two independent readers of the same layout + codec": the dump
 * reads linear memory in the worklet, the test re-encodes the known seeded
 * values with the same codec (`encodeScalar`) and asserts BYTE equality (never a
 * float `===`). The filter-removal is proven by contrast with `snapshot-request`,
 * which omits the anonymous + transient slots the dump surfaces.
 */

import "./dsl/primitives.ts"; // method form registration side-effect

import { expect, test } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { bool, f32, f64, i32, i64 } from "./dsl/constructors.ts";
import { audioOutput, state } from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";
import { decodeScalar, decodeTypedArray, encodeScalar, type SnapshotSlot } from "./snapshot.ts";

type PortListener = (event: MessageEvent) => void;
type MockSelf = {
  port: {
    postMessage: (m: unknown) => void;
    addEventListener: (kind: string, fn: PortListener) => void;
    start: () => void;
    __listeners: PortListener[];
  };
  messages: unknown[];
};

const makeMockSelf = (): MockSelf => {
  const messages: unknown[] = [];
  const listeners: PortListener[] = [];
  const self: MockSelf = {
    port: {
      postMessage: (m: unknown) => messages.push(m),
      addEventListener: (kind: string, fn: PortListener) => {
        if (kind === "message") listeners.push(fn);
      },
      start: () => {},
      __listeners: listeners,
    },
    messages,
  };
  return self;
};

const fireToWorklet = (self: MockSelf, data: unknown): void => {
  for (const listener of self.port.__listeners) listener({ data } as MessageEvent);
};

const lastOfKind = (self: MockSelf, kind: string): Record<string, unknown> | undefined => {
  for (let i = self.messages.length - 1; i >= 0; i--) {
    const m = self.messages[i] as Record<string, unknown>;
    if (m && m["kind"] === kind) return m;
  }
  return undefined;
};

const quantum = () => ({
  inputs: [] as Float32Array[][],
  outputs: [[new Float32Array(SAMPLES_PER_BLOCK)]] as Float32Array[][],
  parameters: {} as Record<string, Float32Array>,
});

const bytes = (u: Uint8Array): number[] => Array.from(u);

// Every scalar type + a buffer + an anonymous slot + a transient slot — so the
// dump must surface strictly more than a persistent-profile snapshot.
const I64_BIG = 9007199254740993n; // 2^53 + 1, beyond f64 integer precision
const xray = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const sf32 = state.f32(0).named("sf32").expose({ snapshot: "persistent" });
    const si32 = state.i32(0).named("si32").expose({ snapshot: "persistent" });
    const si64 = state.i64(0n).named("si64").expose({ snapshot: "persistent" });
    const sf64 = state.f64(0).named("sf64").expose({ snapshot: "persistent" });
    const sbool = state.bool(false).named("sbool").expose({ snapshot: "persistent" });
    // Named but transient → a persistent-profile snapshot omits it; dump keeps it.
    const stransient = state.i32(0).named("stransient").expose({ snapshot: "transient" });
    // Anonymous → no main-side surface, no snapshot entry; dump keeps it.
    const anon = state.f32(0);
    const bf32 = state.buffer.f32({ size: 3 }).named("bf32").expose({ snapshot: "persistent" });
    // Named u8 buffer, no snapshot → transient default; dump keeps it.
    const bu8 = state.buffer.u8({ size: 3 }).named("bu8");
    return {
      process: () => {
        forSample((i) => {
          sf32.write(f32(0.25));
          si32.write(i32(12345));
          si64.write(i64(I64_BIG));
          sf64.write(f64(Math.PI));
          sbool.write(bool(true));
          stransient.write(i32(-7));
          anon.write(f32(-0.5));
          bf32.write(0, f32(1.5));
          bf32.write(1, f32(-2.5));
          bf32.write(2, f32(3.5));
          bu8.write(0, i32(255));
          bu8.write(1, i32(0));
          bu8.write(2, i32(128));
          out.ch(0).at(i).write(sf32.read());
        });
      },
    };
  });

async function seededDump(): Promise<SnapshotSlot[]> {
  const proc = xray();
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });
  // One quantum seeds every slot with its known constant.
  const q = quantum();
  proc.worklet.process(self, q.inputs, q.outputs, q.parameters);
  self.messages.length = 0; // drop any ready/ack chatter
  fireToWorklet(self, { kind: "dev-dump-request", requestId: 42 });
  const resp = lastOfKind(self, "dev-dump-response");
  expect(resp).toBeDefined();
  expect(resp!["requestId"]).toBe(42);
  return resp!["slots"] as SnapshotSlot[];
}

test("dev-dump surfaces every scalar slot byte-exact against an independent encode", async () => {
  const slots = await seededDump();
  const by = new Map(slots.map((s) => [s.name, s]));

  expect(bytes(by.get("sf32")!.data)).toEqual(bytes(encodeScalar("f32", 0.25)));
  expect(decodeScalar("f32", by.get("sf32")!.data)).toBeCloseTo(0.25);

  expect(bytes(by.get("si32")!.data)).toEqual(bytes(encodeScalar("i32", 12345)));
  expect(decodeScalar("i32", by.get("si32")!.data)).toBe(12345);

  // i64 beyond f64 precision must survive as the exact BigInt bit pattern.
  expect(bytes(by.get("si64")!.data)).toEqual(bytes(encodeScalar("i64", I64_BIG)));
  expect(decodeScalar("i64", by.get("si64")!.data)).toBe(I64_BIG);

  expect(bytes(by.get("sf64")!.data)).toEqual(bytes(encodeScalar("f64", Math.PI)));
  expect(decodeScalar("f64", by.get("sf64")!.data)).toBe(Math.PI);

  expect(bytes(by.get("sbool")!.data)).toEqual(bytes(encodeScalar("bool", true)));
  expect(decodeScalar("bool", by.get("sbool")!.data)).toBe(true);
});

test("dev-dump includes transient, anonymous, and non-persistent buffer slots a snapshot omits", async () => {
  const slots = await seededDump();
  const names = slots.map((s) => s.name);

  // Named-transient slot (snapshot would skip on the persistent profile).
  const transient = slots.find((s) => s.name === "stransient")!;
  expect(decodeScalar("i32", transient.data)).toBe(-7);

  // Anonymous slot: synthetic __state_N name, worklet-private, snapshot-invisible.
  const anon = slots.find((s) => s.name.startsWith("__state_"))!;
  expect(anon).toBeDefined();
  expect(decodeScalar("f32", anon.data)).toBeCloseTo(-0.5);

  // u8 buffer (transient default) is present and byte-exact.
  const bu8 = slots.find((s) => s.name === "bu8")!;
  expect(bytes(bu8.data)).toEqual([255, 0, 128]);
  expect(Array.from(decodeTypedArray("u8", bu8.data) as Uint8Array)).toEqual([255, 0, 128]);

  // f32 buffer decodes to the exact written ramp.
  const bf32 = slots.find((s) => s.name === "bf32")!;
  expect(Array.from(decodeTypedArray("f32", bf32.data) as Float32Array)).toEqual([1.5, -2.5, 3.5]);

  expect(names).toContain("stransient");
  expect(names.some((n) => n.startsWith("__state_"))).toBe(true);
  expect(names).toContain("bu8");
});

test("dev-dump is a strict superset of the persistent-profile snapshot", async () => {
  const proc = xray();
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });
  const q = quantum();
  proc.worklet.process(self, q.inputs, q.outputs, q.parameters);
  self.messages.length = 0;

  fireToWorklet(self, { kind: "snapshot-request", requestId: 1, profile: undefined });
  fireToWorklet(self, { kind: "dev-dump-request", requestId: 2 });
  const snap = (lastOfKind(self, "snapshot-response")!["slots"] as SnapshotSlot[]).map(
    (s) => s.name,
  );
  const dump = (lastOfKind(self, "dev-dump-response")!["slots"] as SnapshotSlot[]).map(
    (s) => s.name,
  );

  // Snapshot ⊂ dump, and the dump adds the slots the snapshot filtered out.
  for (const name of snap) expect(dump).toContain(name);
  expect(dump.length).toBeGreaterThan(snap.length);
  expect(snap).not.toContain("stransient");
  expect(dump).toContain("stransient");
});
