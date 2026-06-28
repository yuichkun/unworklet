/**
 * Layer F — the debug self-check is wired into the worklet's process loop.
 *
 * With the `__UNWORKLET_SELFCHECK__` gate on, every quantum audits each ring
 * header and posts a `selfcheck-violation` the instant one is corrupt. Proven
 * both ways: a corrupt header (poked into the live state) is reported, and a
 * normal run is silent. Node tests run with the gate undefined, so the block is
 * skipped everywhere else (zero production cost; prod tree-shakes it entirely).
 */

import "./dsl/primitives.ts";

import { expect, test } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { audioOutput, event } from "./dsl/declarations.ts";
import { forSample } from "./dsl/loop.ts";
import { defineProcessor } from "./processor.ts";

interface MockSelf {
  port: { postMessage: (m: unknown) => void; addEventListener: () => void; start: () => void };
  messages: Array<{ kind?: string }>;
}
const makeMockSelf = (): MockSelf => {
  const messages: Array<{ kind?: string }> = [];
  return {
    port: {
      postMessage: (m) => messages.push(m as { kind?: string }),
      addEventListener: () => {},
      start: () => {},
    },
    messages,
  };
};

// An event-out processor that seals the ring (emitIf(false)) but emits nothing,
// so its header stays put for the test to inspect / corrupt.
const makeProc = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const ev = event<{ x: number }>({ to: "main", name: "ev", capacity: 16 });
    return {
      process: () => {
        ev.emitIf(false, { atSample: 0, x: 0 });
        forSample((i) => {
          out.ch(0).at(i).write(0);
        });
      },
    };
  });

const liveState = (self: MockSelf): { eventRingsWasmHeaderViews: Int32Array[] } => {
  const sym = Object.getOwnPropertySymbols(self).find(
    (s) => s.description === "unworklet.workletState",
  )!;
  return (self as unknown as Record<symbol, { eventRingsWasmHeaderViews: Int32Array[] }>)[sym]!;
};

const quantum = () => [[], [[new Float32Array(128)]], {}] as const;

test("the debug self-check reports a corrupt ring header", async () => {
  (globalThis as Record<string, unknown>)["__UNWORKLET_SELFCHECK__"] = true;
  try {
    const proc = makeProc();
    const { wasm } = await compile(proc);
    const self = makeMockSelf();
    proc.worklet.initialize(self, {
      processorOptions: { wasm, eventRings: proc.worklet.eventRings },
    });
    // Corrupt the event ring header: head 20 over a capacity-16 ring (overfill).
    const header = liveState(self).eventRingsWasmHeaderViews[0]!;
    header[0] = 20;
    header[1] = 0;
    const [i, o, p] = quantum();
    proc.worklet.process(self, i, o, p);
    expect(self.messages.some((m) => m.kind === "selfcheck-violation")).toBe(true);
  } finally {
    delete (globalThis as Record<string, unknown>)["__UNWORKLET_SELFCHECK__"];
  }
});

test("the debug self-check is silent on a valid run", async () => {
  (globalThis as Record<string, unknown>)["__UNWORKLET_SELFCHECK__"] = true;
  try {
    const proc = makeProc();
    const { wasm } = await compile(proc);
    const self = makeMockSelf();
    proc.worklet.initialize(self, {
      processorOptions: { wasm, eventRings: proc.worklet.eventRings },
    });
    const [i, o, p] = quantum();
    proc.worklet.process(self, i, o, p);
    expect(self.messages.some((m) => m.kind === "selfcheck-violation")).toBe(false);
  } finally {
    delete (globalThis as Record<string, unknown>)["__UNWORKLET_SELFCHECK__"];
  }
});
