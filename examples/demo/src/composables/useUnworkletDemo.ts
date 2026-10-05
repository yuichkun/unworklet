// The demo's audio engine. Compiles a `.uwk.ts` source in the browser, wires the
// resulting node to the speakers, and supports live recompile (replaceProcessor +
// a short crossfade). Effects process an input signal (a chosen oscillator /
// noise, or a file you load); instruments are played by holding keys (MIDI).
//
// Params declared in the source (`param.f32(...)`) are surfaced as live sliders:
// each `node.params[name]` is a native `AudioParam` carrying its own min / max /
// default, so the UI reads ranges and writes values with no extra metadata.
import { createNode, replaceProcessor } from "@unworklet/core";
import type { UnworkletNode } from "@unworklet/core";
import { ref } from "vue";

import type { Example } from "../examples.ts";
import { compileSource } from "@unworklet/lang/browser";

const FADE = 0.08;
const MASTER = 0.9;

export type SourceType = "sawtooth" | "sine" | "square" | "triangle" | "noise";
export type ParamControl = {
  name: string;
  min: number;
  max: number;
  default: number;
  value: number;
};

export function useUnworkletDemo() {
  const status = ref<string>("idle");
  const error = ref<string | null>(null);
  const ready = ref(false);
  const playing = ref(false);
  const busy = ref(false);
  const params = ref<ParamControl[]>([]);
  const sourceType = ref<SourceType>("sawtooth");
  const freq = ref(110);

  let ctx: AudioContext | null = null;
  let node: UnworkletNode<unknown> | null = null;
  let master: GainNode | null = null;
  let output: GainNode | null = null;
  let source: AudioBufferSourceNode | OscillatorNode | null = null;
  let fileBuffer: AudioBuffer | null = null;
  let current: Example | null = null;
  let generation = 0;
  let playRequest = 0;
  const retiring = new Set<() => void>();

  const ensureCtx = async (): Promise<AudioContext> => {
    const c = (ctx ??= new AudioContext({ sampleRate: 48000 }));
    if (c.state === "suspended") await c.resume();
    return c;
  };

  const makeNoise = (c: AudioContext): AudioBufferSourceNode => {
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    return s;
  };

  const makeSource = (c: AudioContext): AudioBufferSourceNode | OscillatorNode => {
    if (fileBuffer) {
      const s = c.createBufferSource();
      s.buffer = fileBuffer;
      s.loop = true;
      return s;
    }
    if (sourceType.value === "noise") return makeNoise(c);
    const o = c.createOscillator();
    o.type = sourceType.value;
    o.frequency.value = freq.value;
    return o;
  };

  const watchErrors = (n: UnworkletNode<unknown>): void => {
    n.onError((e) => {
      error.value = `worklet error: ${JSON.stringify(e)}`;
    });
  };

  // Reads the live param list off a node, preserving any values the user has
  // already dialled in (matched by name) so a recompile doesn't reset the sliders.
  const syncParams = (n: UnworkletNode<unknown>, preserve: boolean): void => {
    const prev = preserve ? new Map(params.value.map((p) => [p.name, p.value])) : null;
    const t = ctx?.currentTime ?? 0;
    params.value = Object.entries(n.params).map(([name, p]) => {
      const value = prev?.get(name) ?? p.value;
      if (prev?.has(name)) p.setValueAtTime(value, t);
      return { name, min: p.minValue, max: p.maxValue, default: p.defaultValue, value };
    });
  };

  // Effects remain muted until Play, including processors that generate sound
  // without an input. Instruments use their own MIDI note gates.
  async function prepare(ex: Example): Promise<void> {
    const revision = ++generation;
    teardown();
    current = ex;
    busy.value = true;
    ready.value = false;
    error.value = null;
    status.value = "compiling…";
    try {
      const c = await ensureCtx();
      if (revision !== generation) return;
      const compiled = await compileSource(ex.source);
      if (revision !== generation) return;
      const prepared = await createNode(c, compiled);
      if (revision !== generation) {
        prepared.dispose();
        return;
      }
      node = prepared;
      output = c.createGain();
      output.gain.value = ex.kind === "instrument" ? 1 : 0;
      output.connect(c.destination);
      master = c.createGain();
      master.gain.value = MASTER;
      node.outputs["main"]!.connect(master);
      master.connect(output);
      watchErrors(node);
      syncParams(node, false);
      ready.value = true;
      status.value = "ready";
    } catch (e) {
      if (revision !== generation) return;
      error.value = String(e);
      status.value = "compile failed";
    } finally {
      if (revision === generation) busy.value = false;
    }
  }

  function stopSource(): void {
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
      source = null;
    }
  }

  // Effects only: run the chosen input source through the node.
  // A "generator" effect (no `audioInput` named "main") skips the source — the
  // processor synthesises its own signal (e.g. noise, oscillator) into the output.
  async function play(): Promise<void> {
    if (!node || !output) return;
    const request = ++playRequest;
    const revision = generation;
    let c: AudioContext;
    try {
      c = await ensureCtx();
    } catch (e) {
      if (request !== playRequest || revision !== generation) return;
      throw e;
    }
    if (request !== playRequest || revision !== generation || !node || !output) return;
    if (current?.kind === "effect") {
      stopSource();
      const mainIn = node.inputs["main"];
      if (mainIn) {
        source = makeSource(c);
        source.connect(mainIn);
        source.start();
      }
    }
    output.gain.value = 1;
    playing.value = true;
  }

  function stop(): void {
    playRequest++;
    if (output) output.gain.value = 0;
    stopSource();
    playing.value = false;
  }

  function setSource(type: SourceType): void {
    sourceType.value = type;
    if (playing.value && current?.kind === "effect") void play();
  }

  function setFreq(hz: number): void {
    freq.value = hz;
    if (source instanceof OscillatorNode && ctx)
      source.frequency.setValueAtTime(hz, ctx.currentTime);
  }

  function setParam(name: string, value: number): void {
    if (!ctx || !node) return;
    node.params[name]?.setValueAtTime(value, ctx.currentTime);
  }

  // Instruments: hold-to-sound. The first press resumes the context (the gesture).
  function noteOn(note: number): void {
    if (ctx?.state === "suspended") void ctx.resume();
    const port = current?.midiPort ? node?.midi[current.midiPort] : undefined;
    port?.send({ type: "noteOn", channel: 0, note, velocity: 100 });
  }
  function noteOff(note: number): void {
    const port = current?.midiPort ? node?.midi[current.midiPort] : undefined;
    port?.send({ type: "noteOff", channel: 0, note, velocity: 0 });
  }

  async function recompile(newSource: string): Promise<void> {
    if (!ctx || !node || !master || !output || busy.value) return;
    const revision = generation;
    const c = ctx;
    const previous = node;
    busy.value = true;
    status.value = "recompiling…";
    error.value = null;
    try {
      const compiled = await compileSource(newSource);
      if (revision !== generation) return;
      const r = await replaceProcessor(previous, compiled);
      if (revision !== generation) {
        r.node.dispose();
        return;
      }
      const newMaster = c.createGain();
      newMaster.gain.value = 0;
      r.node.outputs["main"]!.connect(newMaster);
      // Both sides of the crossfade share the transport gate, so Stop also
      // silences a retiring generator while its fade-out is still scheduled.
      newMaster.connect(output);
      if (current?.kind === "effect") {
        const nextInput = r.node.inputs["main"];
        if (source) {
          source.disconnect();
          if (nextInput) source.connect(nextInput);
          else stopSource();
        } else if (playing.value && nextInput) {
          source = makeSource(c);
          source.connect(nextInput);
          source.start();
        }
      }
      const t = c.currentTime;
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + FADE);
      newMaster.gain.setValueAtTime(0, t);
      newMaster.gain.linearRampToValueAtTime(MASTER, t + FADE);
      const oldNode = node;
      const oldMaster = master;
      node = r.node;
      master = newMaster;
      watchErrors(node);
      syncParams(node, true);
      const cleanup = () => {
        window.clearTimeout(timer);
        oldMaster.disconnect();
        oldNode.dispose();
        retiring.delete(cleanup);
      };
      const timer = window.setTimeout(cleanup, FADE * 1000 + 80);
      retiring.add(cleanup);
      status.value = `recompiled${r.applied.length ? ` (carried ${r.applied.join(", ")})` : ""}`;
    } catch (e) {
      if (revision !== generation) return;
      error.value = String(e);
      status.value = "recompile failed";
    } finally {
      if (revision === generation) busy.value = false;
    }
  }

  async function loadFile(file: File): Promise<void> {
    const c = await ensureCtx();
    fileBuffer = await c.decodeAudioData(await file.arrayBuffer());
    if (playing.value && current?.kind === "effect") void play();
  }

  function teardown(): void {
    stop();
    ready.value = false;
    for (const cleanup of retiring) cleanup();
    node?.dispose();
    node = null;
    master?.disconnect();
    master = null;
    output?.disconnect();
    output = null;
  }

  async function destroy(): Promise<void> {
    generation++;
    teardown();
    busy.value = false;
    const c = ctx;
    ctx = null;
    await c?.close();
  }

  return {
    status,
    error,
    ready,
    playing,
    busy,
    params,
    sourceType,
    freq,
    prepare,
    play,
    stop,
    setSource,
    setFreq,
    setParam,
    noteOn,
    noteOff,
    recompile,
    loadFile,
    destroy,
  };
}
