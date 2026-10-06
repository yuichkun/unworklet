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
