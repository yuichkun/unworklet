/**
 * UW-1 pocket rack — audio engine (P7).
 *
 * Signal flow (the "drone bed + live lead" patch):
 *
 *   noise-drive ─▶ bedGain ─┐
 *                            ├─▶ mix ─▶ tape-delay ─▶ crusher ─▶ tone(LP) ─▶ master ─▶ out
 *   midi-synth  ────────────┘
 *
 * `play` ramps the noise bed up (an evolving lo-fi texture through tape+crush);
 * the on-screen keyboard plays the mono synth lead on top, also through the
 * effects. `tone` / `vol` are Web-Audio post nodes. The four `.uwk.ts` processors
 * are consumed via `?worklet`, exactly as any app would.
 */

import { createNode } from "@unworklet/core";
import type { UnworkletNode } from "@unworklet/core";

import crusher from "./processors/crusher.uwk.ts?worklet";
import midiSynth from "./processors/midi-synth.uwk.ts?worklet";
import noiseDrive from "./processors/noise-drive.uwk.ts?worklet";
import tapeDelay from "./processors/tape-delay.uwk.ts?worklet";

type Node = UnworkletNode<unknown>;

let ctx: AudioContext | undefined;
let nodes: Node[] = [];
let synth: Node | undefined;
let bedGain: GainNode | undefined;
let tone: BiquadFilterNode | undefined;
let master: GainNode | undefined;

const BED_LEVEL = 0.4;

/** Boot the AudioContext + rack on the first user gesture (idempotent). */
async function ensureAudio(): Promise<void> {
  if (ctx) return;
  const audioCtx = new AudioContext();
  await audioCtx.resume();

  const noise = await createNode(audioCtx, noiseDrive);
  const tape = await createNode(audioCtx, tapeDelay);
  const crush = await createNode(audioCtx, crusher);
  const synthNode = await createNode(audioCtx, midiSynth);
  nodes = [noise, tape, crush, synthNode];
  synth = synthNode;

  bedGain = new GainNode(audioCtx, { gain: 0 }); // muted until `play`
  const mix = new GainNode(audioCtx, { gain: 1 });
  // Defaults match the panel's knob defaults (tone 0.5 → setTone curve, vol 0.7).
  tone = new BiquadFilterNode(audioCtx, { type: "lowpass", frequency: 2950, Q: 0.7 });
  master = new GainNode(audioCtx, { gain: 0.7 });

  noise.outputs["main"]!.connect(bedGain);
  bedGain.connect(mix);
  synthNode.outputs["main"]!.connect(mix);
  mix.connect(tape.inputs["main"]!);
  tape.outputs["main"]!.connect(crush.inputs["main"]!);
  crush.outputs["main"]!.connect(tone);
  tone.connect(master);
  master.connect(audioCtx.destination);

  ctx = audioCtx;
}

/** `play` — boot if needed and ramp the noise bed up. */
export async function startBed(): Promise<void> {
  await ensureAudio();
  bedGain!.gain.setTargetAtTime(BED_LEVEL, ctx!.currentTime, 0.12);
}

/** `stop` — ramp the noise bed down (keyboard stays live). */
export function stopBed(): void {
  if (!ctx || !bedGain) return;
  bedGain.gain.setTargetAtTime(0, ctx.currentTime, 0.18);
}

export async function noteOn(note: number): Promise<void> {
  await ensureAudio();
  synth?.midi["notes"]?.send({ type: "noteOn", channel: 0, note, velocity: 100 });
}

export function noteOff(note: number): void {
  synth?.midi["notes"]?.send({ type: "noteOff", channel: 0, note, velocity: 0 });
}

/** `vol` knob (0..1) → master gain. */
export function setVol(v: number): void {
  if (master && ctx) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

/** `tone` knob (0..1) → low-pass cutoff (≈200 Hz .. 11 kHz, perceptual curve). */
export function setTone(v: number): void {
  if (tone && ctx) tone.frequency.setTargetAtTime(200 + v * v * 11000, ctx.currentTime, 0.02);
}

export function dispose(): void {
  for (const n of nodes) n.dispose();
  nodes = [];
  void ctx?.close();
  ctx = undefined;
}
