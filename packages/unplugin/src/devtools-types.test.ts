import { expect, test } from "vite-plus/test";
import type { DevMidiInject, DevMidiInjectCommand } from "./index.ts";

test("the published MIDI command types remain constructible without internal page routing fields", () => {
  const command: DevMidiInjectCommand = {
    seq: 1,
    nodeId: "n0",
    port: "in",
    event: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
  };
  const queue: DevMidiInject = { commands: [command] };
  expect(queue.commands).toEqual([command]);
});

test("published shared-state keys retain their original raw snapshot and queue shapes", () => {
  const states: Pick<
    import("@vitejs/devtools-kit").DevToolsRpcSharedStates,
    | "unworklet:graph"
    | "unworklet:state"
    | "unworklet:signals"
    | "unworklet:midi"
    | "unworklet:midi-inject"
  > = {
    "unworklet:graph": { nodes: [], edges: [] },
    "unworklet:state": { nodes: [] },
    "unworklet:signals": {
      nodes: [],
      context: { sampleRate: 0, baseLatencyMs: 0, outputLatencyMs: 0 },
    },
    "unworklet:midi": { ports: [], log: [] },
    "unworklet:midi-inject": {
      commands: [
        {
          seq: 1,
          nodeId: "n0",
          port: "in",
          event: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        },
      ],
    },
  };
  expect(states["unworklet:graph"].nodes).toEqual([]);
  expect(states["unworklet:midi-inject"].commands).toHaveLength(1);
});
