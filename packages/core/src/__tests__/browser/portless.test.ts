import { expect, test } from "vite-plus/test";
import { createNode } from "../../index.ts";
import type { MidiEvent } from "../../types.ts";
import portless from "./fixtures/portless.processor.ts?worklet";

test("a MIDI-only processor can be created and delivers messages without declared audio ports", async () => {
  const ctx = new OfflineAudioContext(1, 1024, 48000);
  const node = await createNode(ctx, portless);
  try {
    expect(Object.keys(node.inputs)).toEqual([]);
    expect(Object.keys(node.outputs)).toEqual([]);
    node.node.connect(ctx.destination);
    const received: MidiEvent[] = [];
    node.midi.output!.onEvent("noteOn", (e) => received.push(e));
    node.midi.input!.send({ type: "noteOn", channel: 0, note: 60, velocity: 100 });
    const rendered = await ctx.startRendering();
    await expect
      .poll(() => received)
      .toEqual([{ type: "noteOn", channel: 0, note: 60, velocity: 100 }]);
    expect(Array.from(rendered.getChannelData(0))).toEqual(Array(1024).fill(0));
  } finally {
    node.dispose();
  }
});
