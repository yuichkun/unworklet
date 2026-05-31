/**
 * RC-20-style supply app. A plain unworklet app — zero devtools code — whose
 * only job is to run several live nodes so the DevTools panel (and the
 * chrome-devtools verification) has real linear memory to X-ray. The plugin
 * auto-registers each node via the dev gate; nothing here touches a devtools API.
 *
 * Chain: noiseDrive → tapeDelay → crusher → (quiet) destination; midiSynth in
 * parallel. Kept at low gain so it runs without being loud.
 */

import { createNode } from "@unworklet/core";
import type { UnworkletNode } from "@unworklet/core";

import crusher from "./processors/crusher.processor.ts?worklet";
import midiSynth from "./processors/midi-synth.processor.ts?worklet";
import noiseDrive from "./processors/noise-drive.processor.ts?worklet";
import tapeDelay from "./processors/tape-delay.processor.ts?worklet";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

let ctx: AudioContext | undefined;
const nodes: UnworkletNode<unknown>[] = [];

async function start(): Promise<void> {
  if (ctx) return;
  ctx = new AudioContext();
  await ctx.resume();

  const noise = (await createNode(ctx, noiseDrive)) as UnworkletNode<unknown>;
  const delay = (await createNode(ctx, tapeDelay)) as UnworkletNode<unknown>;
  const crush = (await createNode(ctx, crusher)) as UnworkletNode<unknown>;
  const synth = (await createNode(ctx, midiSynth)) as UnworkletNode<unknown>;
  nodes.push(noise, delay, crush, synth);

  noise.outputs["main"]!.connect(delay.inputs["main"]!);
  delay.outputs["main"]!.connect(crush.inputs["main"]!);

  // Quiet tap to the destination so the rack runs (process() executes) without
  // being loud during verification.
  const gain = new GainNode(ctx, { gain: 0.04 });
  crush.outputs["main"]!.connect(gain);
  synth.outputs["main"]!.connect(gain);
  gain.connect(ctx.destination);

  statusEl.textContent = `running — ${nodes.length} unworklet nodes (open the unworklet DevTools dock)`;
  startBtn.disabled = true;
}

startBtn.addEventListener("click", () => {
  start().catch((e: unknown) => {
    statusEl.textContent = `error: ${String(e)}`;
  });
});
