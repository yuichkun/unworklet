import { expect, test } from "vite-plus/test";

import { mapLog, mapOverflow, mapPorts, type MidiShared, normalizeMidi } from "./useLiveMidi";

const sample = (): MidiShared => ({
  ports: [
    { nodeId: "n0", node: "arp", name: "keys", direction: "in", overflow: 0 },
    { nodeId: "n0", node: "arp", name: "arpOut", direction: "out", overflow: 3 },
  ],
  log: [
    {
      seq: 1,
      ts: 1000,
      dir: "inject",
      nodeId: "n0",
      port: "keys",
      event: { type: "noteOn", channel: 0, note: 60, velocity: 96 },
    },
    {
      seq: 2,
      ts: 1010,
      dir: "out",
      nodeId: "n0",
      port: "arpOut",
      event: { type: "noteOff", channel: 0, note: 60, velocity: 0 },
    },
  ],
});

test("normalizeMidi: undefined / partial → empty arrays (crash guard)", () => {
  expect(normalizeMidi(undefined)).toEqual({ ports: [], log: [] });
  expect(normalizeMidi({} as unknown as MidiShared)).toEqual({ ports: [], log: [] });
});

test("mapPorts: in → input, out → output", () => {
  expect(mapPorts(sample())).toEqual([
    { nodeId: "n0", portName: "keys", kind: "input" },
    { nodeId: "n0", portName: "arpOut", kind: "output" },
  ]);
});

test("mapOverflow: real per-port counts keyed by nodeId.portName", () => {
  expect(mapOverflow(sample())).toEqual({ "n0.keys": 0, "n0.arpOut": 3 });
});

test("mapLog: projects to panel entries, newest first", () => {
  const log = mapLog(sample());
  // Reversed → seq 2 first.
  expect(log.map((e) => e.id)).toEqual([2, 1]);
  expect(log[0]).toEqual({
    id: 2,
    ts: 1010,
    portKey: "n0.arpOut",
    direction: "out",
    event: { type: "noteOff", channel: 0, note: 60, velocity: 0 },
  });
  expect(log[1]!.direction).toBe("inject");
});
