import "./dsl/primitives.ts";

import { afterEach, expect, test, vi } from "vite-plus/test";

import { compile } from "./compile/index.ts";
import { audioOutput, event, state } from "./dsl/declarations.ts";
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

// Idle rings leave injected headers untouched; an accumulating signal proves
// that diagnostics do not interrupt DSP or reset its state.
const makeProc = () =>
  defineProcessor(() => {
    const out = audioOutput({ channels: 1, name: "out" });
    const count = state.f32(0);
    const capacities = [16, 32] as const;
    const events = capacities.map((capacity, i) =>
      event<{ x: number }>({ to: "main", name: `event${i}`, capacity }),
    );
    for (const [i, capacity] of capacities.entries()) {
      event<{ x: number }>({ from: "main", name: `message${i}`, capacity });
    }
    event.midi({ from: "main", name: "midi0", capacity: 16 });
    const midi = event.midi({ to: "main", name: "midi1", capacity: 32 });
    return {
      process: () => {
        for (const ev of events) ev.emitIf(false, { atSample: 0, x: 0 });
        midi.emitIf(false, { type: "noteOn", channel: 0, note: 60, velocity: 100, atSample: 0 });
        forSample((i) => {
          count.write(count.read().add(1));
          out.ch(0).at(i).write(count.read());
        });
      },
    };
  });

interface LiveState {
  eventRingsWasmHeaderViews: Int32Array[];
  messageRingsWasmHeaderViews: Int32Array[];
  midiRingsWasmHeaderViews: Int32Array[];
  eventRings: Array<{ capacity: number }>;
  messageRings: Array<{ capacity: number }>;
  midiRings: Array<{ capacity: number }>;
}
const liveState = (self: MockSelf): LiveState => {
  const sym = Object.getOwnPropertySymbols(self).find(
    (s) => s.description === "unworklet.workletState",
  )!;
  return (self as unknown as Record<symbol, LiveState>)[sym]!;
};

const families = [
  { kind: "event", headers: "eventRingsWasmHeaderViews", rings: "eventRings" },
  { kind: "message", headers: "messageRingsWasmHeaderViews", rings: "messageRings" },
  { kind: "midi", headers: "midiRingsWasmHeaderViews", rings: "midiRings" },
] as const;

const setup = async () => {
  const proc = makeProc();
  const { wasm } = await compile(proc);
  const self = makeMockSelf();
  proc.worklet.initialize(self, {
    processorOptions: {
      wasm,
      transport: "postMessage",
      eventRings: proc.worklet.eventRings,
      messageRings: proc.worklet.messageRings,
      midiRings: proc.worklet.midiRings,
    },
  });
  expect(self.messages).toContainEqual({ kind: "ready" });
  return { proc, self, live: liveState(self) };
};

const diagnostics = (self: MockSelf) =>
  self.messages.filter((message) => message.kind === "selfcheck-violation");

const processQuantum = (fixture: Awaited<ReturnType<typeof setup>>, quantum: number) => {
  const before = families.map(({ headers }) => fixture.live[headers].map((h) => Array.from(h)));
  const output = new Float32Array(128);
  expect(fixture.proc.worklet.process(fixture.self, [], [[output]], {})).toBe(true);
  expect(Array.from(output)).toEqual(Array.from({ length: 128 }, (_, i) => quantum * 128 + i + 1));
  expect(families.map(({ headers }) => fixture.live[headers].map((h) => Array.from(h)))).toEqual(
    before,
  );
};

afterEach(() => vi.unstubAllGlobals());

const faults = [
  {
    name: "overfill",
    header: [33, 0, 0],
    capacity: 32,
    detail: "ring header corrupt: head=33 tail=0 → fill 33 exceeds capacity 32",
  },
  {
    name: "tail rewind",
    header: [0, 1, 0],
    capacity: 32,
    detail: "ring header corrupt: head=0 tail=1 → fill 4294967295 exceeds capacity 32",
  },
  {
    name: "negative overflow",
    header: [0, 0, -1],
    capacity: 32,
    detail: "ring overflow counter is negative: -1",
  },
  {
    name: "zero capacity",
    header: [0, 0, 0],
    capacity: 0,
    detail: "ring capacity must be positive, got 0",
  },
  {
    name: "negative capacity",
    header: [0, 0, 0],
    capacity: -1,
    detail: "ring capacity must be positive, got -1",
  },
];

for (const family of families) {
  test.each(faults)(
    `${family.kind}[1] reports $name once per quantum with exact attribution`,
    async (fault) => {
      vi.stubGlobal("__UNWORKLET_SELFCHECK__", true);
      const fixture = await setup();
      fixture.live[family.headers][1]!.set(fault.header);
      // Capacity corruption is injected after initialization, not accepted as a declaration.
      fixture.live[family.rings][1]!.capacity = fault.capacity;
      const expected = {
        kind: "selfcheck-violation",
        ring: `${family.kind}[1]`,
        detail: fault.detail,
      };
      processQuantum(fixture, 0);
      expect(diagnostics(fixture.self)).toEqual([expected]);
      processQuantum(fixture, 1);
      expect(diagnostics(fixture.self)).toEqual([expected, expected]);
      fixture.live[family.headers][1]!.fill(0);
      fixture.live[family.rings][1]!.capacity = 32;
      processQuantum(fixture, 2);
      expect(diagnostics(fixture.self)).toEqual([expected, expected]);
    },
  );
}

test.each([
  { name: "empty", header: [0, 0, 0] },
  { name: "full with positive overflow", header: [39, 7, 4] },
  { name: "signed counter wrap", header: [-2147483632, 2147483632, 0] },
  { name: "unsigned counter wrap", header: [16, -16, 0] },
])("all ring families accept $name without changing PCM or state", async ({ header }) => {
  vi.stubGlobal("__UNWORKLET_SELFCHECK__", true);
  const fixture = await setup();
  for (const { headers } of families) fixture.live[headers][1]!.set(header);
  processQuantum(fixture, 0);
  processQuantum(fixture, 1);
  expect(diagnostics(fixture.self)).toEqual([]);
});

test.each([false, undefined])(
  "the %s self-check gate leaves corrupt rings silent",
  async (gate) => {
    vi.stubGlobal("__UNWORKLET_SELFCHECK__", gate);
    const fixture = await setup();
    for (const { headers } of families) fixture.live[headers][1]!.set([0, 0, -1]);
    processQuantum(fixture, 0);
    processQuantum(fixture, 1);
    expect(diagnostics(fixture.self)).toEqual([]);
  },
);

test("identical violations in separate rings are each reported exactly once", async () => {
  vi.stubGlobal("__UNWORKLET_SELFCHECK__", true);
  const fixture = await setup();
  for (const { headers } of families) {
    for (const header of fixture.live[headers]) header.set([0, 0, -1]);
  }
  processQuantum(fixture, 0);
  expect(diagnostics(fixture.self)).toEqual(
    ["event[0]", "event[1]", "message[0]", "message[1]", "midi[0]", "midi[1]"].map((ring) => ({
      kind: "selfcheck-violation",
      ring,
      detail: "ring overflow counter is negative: -1",
    })),
  );
});
