/**
 * Browser e2e: MIDI transport round-trip through a REAL `AudioWorklet` thread
 * (`11-midi.md` §4). `node.midi.in.send(...)` crosses the main → worklet boundary
 * (SAB ring or postMessage), the worklet thru re-emits, and `node.midi.out.onEvent`
 * receives it back on the main thread. `OfflineAudioContext` drives the worklet's
 * `process()` deterministically, so this exercises the real cross-thread ring
 * buffers + `Atomics` that the node mock cannot — without real-time flakiness.
 */

import { expect, test } from "vite-plus/test";

import { createNode } from "../../index.ts";
import type { MidiEvent } from "../../types.ts";
import midiThru from "./fixtures/midi-thru.processor.ts?worklet";

const SAMPLE_RATE = 48_000;

const waitRAF = (ticks: number): Promise<void> =>
  new Promise<void>((resolve) => {
    let n = 0;
    const wait = (): void => {
      n += 1;
      if (n >= ticks) {
        resolve();
        return;
      }
      requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  });

const buildContext = (durationQuanta: number): OfflineAudioContext =>
  new OfflineAudioContext({
    numberOfChannels: 1,
    length: 128 * durationQuanta,
    sampleRate: SAMPLE_RATE,
  });

test("midi: send noteOn → worklet thru → onEvent receives it back across the thread", async () => {
  const ctx = buildContext(8);
  const node = await createNode(ctx, midiThru);
  node.outputs["main"]!.connect(ctx.destination);
  const received: MidiEvent[] = [];
  node.midi["out"]!.onEvent("noteOn", (e) => received.push(e));
  node.midi["in"]!.send({ type: "noteOn", channel: 3, note: 60, velocity: 100 });
  await ctx.startRendering();
  await waitRAF(3); // let the rAF poll drain the mirrored out-ring
  expect(received).toContainEqual({ type: "noteOn", channel: 3, note: 60, velocity: 100 });
  node.dispose();
});

test("midi: cc round-trips through the worklet thru unchanged", async () => {
  const ctx = buildContext(8);
  const node = await createNode(ctx, midiThru);
  node.outputs["main"]!.connect(ctx.destination);
  const received: MidiEvent[] = [];
  node.midi["out"]!.onEvent("cc", (e) => received.push(e));
  node.midi["in"]!.send({ type: "cc", channel: 1, controller: 74, value: 99 });
  await ctx.startRendering();
  await waitRAF(3);
  expect(received).toContainEqual({ type: "cc", channel: 1, controller: 74, value: 99 });
  node.dispose();
});

test("midi: a noteOn handler does not fire the cc subscriber (type discrimination)", async () => {
  const ctx = buildContext(8);
  const node = await createNode(ctx, midiThru);
  node.outputs["main"]!.connect(ctx.destination);
  const notes: MidiEvent[] = [];
  const ccs: MidiEvent[] = [];
  node.midi["out"]!.onEvent("noteOn", (e) => notes.push(e));
  node.midi["out"]!.onEvent("cc", (e) => ccs.push(e));
  node.midi["in"]!.send({ type: "noteOn", channel: 0, note: 64, velocity: 1 });
  await ctx.startRendering();
  await waitRAF(3);
  expect(notes).toHaveLength(1);
  expect(ccs).toHaveLength(0);
  node.dispose();
});

test("midi: no send → out port stays empty (= regression)", async () => {
  const ctx = buildContext(8);
  const node = await createNode(ctx, midiThru);
  node.outputs["main"]!.connect(ctx.destination);
  const received: MidiEvent[] = [];
  node.midi["out"]!.onEvent("noteOn", (e) => received.push(e));
  await ctx.startRendering();
  await waitRAF(3);
  expect(received).toHaveLength(0);
  node.dispose();
});
