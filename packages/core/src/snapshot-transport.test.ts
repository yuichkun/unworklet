/**
 * Worklet-side snapshot / restore (`05-client.md` §2.6, `01-dsl.md` §8) against a
 * REAL compiled WASM module. snapshot / restore travel as postMessage
 * request-response handled in the worklet's port listener, which (in a live
 * AudioWorklet) runs at the render-quantum boundary — so reading / writing linear
 * memory there is block-atomic by construction (`06-runtime.md` §6.1).
 *
 * The oracle is round-trip identity through real linear memory: a value written
 * by `restore` must be observable both in the next `process()` output AND in a
 * subsequent `snapshot` capture. The persistent-slot read / write logic mirrors
 * the offline renderer's end-of-render capture + `config.restore` (which is
 * separately verified), so this test focuses on the worklet message wiring.
 */

import "./dsl/primitives.ts"; // method form registration side-effect

import { expect, test } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { SAMPLES_PER_BLOCK } from "./dsl/constants.ts";
import { audioOutput, state } from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";
import { decodeScalar, encodeScalar, type SnapshotSlot } from "./snapshot.ts";

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

// Persistent state slot mirrored straight to the audio output, so its live value
// is observable both via `process()` output and via a snapshot capture.
const gainEcho = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const gain = state.named("gain").f32(0);
    return {
      process: () => {
        forSample((i) => {
          out.ch(0).at(i).write(gain.load());
        });
      },
    };
  });

test("restore writes a persistent state slot into linear memory (next process reads it)", async () => {
  const proc = gainEcho();
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });

  // Initially the state is its declared initial (0).
  let q = quantum();
  proc.worklet.process(self, q.inputs, q.outputs, q.parameters);
  expect(q.outputs[0]![0]![0]).toBe(0);

  // Restore a blob slot (= what the client sends after decode/migrate).
  fireToWorklet(self, {
    kind: "restore",
    requestId: 1,
    slots: [{ name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.5) }],
  });
  const done = lastOfKind(self, "restore-done")!;
  expect(done["requestId"]).toBe(1);
  expect(done["applied"]).toEqual(["gain"]);

  // The next quantum reads the restored value.
  q = quantum();
  proc.worklet.process(self, q.inputs, q.outputs, q.parameters);
  expect(q.outputs[0]![0]![0]).toBeCloseTo(0.5);
});

test("snapshot captures the persistent slot's live value from linear memory", async () => {
  const proc = gainEcho();
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });

  // Restore 0.75, then snapshot — the capture must read the just-written value.
  fireToWorklet(self, {
    kind: "restore",
    requestId: 1,
    slots: [{ name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.75) }],
  });
  fireToWorklet(self, { kind: "snapshot-request", requestId: 2, profile: undefined });

  const resp = lastOfKind(self, "snapshot-response")!;
  expect(resp["requestId"]).toBe(2);
  const slots = resp["slots"] as SnapshotSlot[];
  expect(slots).toHaveLength(1);
  expect(slots[0]!.name).toBe("gain");
  expect(slots[0]!.kind).toBe("state");
  expect(decodeScalar("f32", slots[0]!.data)).toBeCloseTo(0.75);
});

test("restore reports an unknown slot name as skipped, not applied", async () => {
  const proc = gainEcho();
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });

  fireToWorklet(self, {
    kind: "restore",
    requestId: 1,
    slots: [
      { name: "gain", kind: "state", type: "f32", data: encodeScalar("f32", 0.3) },
      { name: "ghost", kind: "state", type: "f32", data: encodeScalar("f32", 9) },
    ],
  });
  const done = lastOfKind(self, "restore-done")!;
  expect(done["applied"]).toEqual(["gain"]);
  expect(done["skipped"]).toEqual(["ghost"]);
});

test("restore reports a persistent slot absent from the blob as missing", async () => {
  const proc = gainEcho();
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });

  // Empty restore — 'gain' is a persistent declaration with no provided value.
  fireToWorklet(self, { kind: "restore", requestId: 1, slots: [] });
  const done = lastOfKind(self, "restore-done")!;
  expect(done["applied"]).toEqual([]);
  expect(done["missing"]).toEqual(["gain"]);
});

test("snapshot of a processor with no persistent slots returns an empty slot list", async () => {
  // Audio-only processor (synthetic state name → not user-named → not persistent).
  const proc = defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "main" });
    const acc = state.f32(0); // synthetic name → worklet-private, not snapshotted
    return {
      process: () => {
        forSample((i) => {
          acc.store(acc.load());
          out.ch(0).at(i).write(0);
        });
      },
    };
  });
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, { processorOptions: { wasm } });

  fireToWorklet(self, { kind: "snapshot-request", requestId: 1, profile: undefined });
  const resp = lastOfKind(self, "snapshot-response")!;
  expect(resp["slots"]).toEqual([]);
});
