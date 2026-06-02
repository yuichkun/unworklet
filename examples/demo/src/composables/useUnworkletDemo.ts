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
  let source: AudioBufferSourceNode | OscillatorNode | null = null;
  let fileBuffer: AudioBuffer | null = null;
  let fileName: string | null = null;
  let current: Example | null = null;

  const ensureCtx = async (): Promise<AudioContext> => {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    return ctx;
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

  // Compile + instantiate the example and wire it to the speakers, WITHOUT
  // starting any input source — silent until the user plays. Populates the param
  // sliders so the controls are live before the first note.
  async function prepare(ex: Example): Promise<void> {
    const c = await ensureCtx();
    await teardown();
    current = ex;
    busy.value = true;
    ready.value = false;
    error.value = null;
    status.value = "compiling…";
    try {
      node = await createNode(c, await compileSource(ex.source));
      master = c.createGain();
      master.gain.value = MASTER;
      node.outputs["main"]!.connect(master);
      master.connect(c.destination);
      watchErrors(node);
      syncParams(node, false);
      ready.value = true;
      status.value = "ready";
    } catch (e) {
      error.value = String(e);
      status.value = "compile failed";
    } finally {
      busy.value = false;
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
  async function play(): Promise<void> {
    if (!node) return;
    const c = await ensureCtx();
    if (current?.kind === "effect") {
      stopSource();
      source = makeSource(c);
      source.connect(node.inputs["main"]!);
      source.start();
    }
    playing.value = true;
  }

  function stop(): void {
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
    if (!ctx || !node || !master || busy.value) return;
    busy.value = true;
    status.value = "recompiling…";
    error.value = null;
    try {
      const r = await replaceProcessor(node, await compileSource(newSource));
      const newMaster = ctx.createGain();
      r.node.outputs["main"]!.connect(newMaster);
      newMaster.connect(ctx.destination);
      if (current?.kind === "effect" && source) {
        source.disconnect();
        source.connect(r.node.inputs["main"]!);
      }
      const t = ctx.currentTime;
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
      window.setTimeout(
        () => {
          oldMaster.disconnect();
          oldNode.dispose();
        },
        FADE * 1000 + 80,
      );
      status.value = `recompiled${r.applied.length ? ` (carried ${r.applied.join(", ")})` : ""}`;
    } catch (e) {
      error.value = String(e);
      status.value = "recompile failed";
    } finally {
      busy.value = false;
    }
  }

  async function loadFile(file: File): Promise<void> {
    const c = await ensureCtx();
    fileBuffer = await c.decodeAudioData(await file.arrayBuffer());
    fileName = file.name;
    if (playing.value && current?.kind === "effect") void play();
  }
  function clearFile(): void {
    fileBuffer = null;
    fileName = null;
    if (playing.value && current?.kind === "effect") void play();
  }
  const loadedFileName = (): string | null => fileName;

  async function teardown(): Promise<void> {
    stop();
    node?.dispose();
    node = null;
    master?.disconnect();
    master = null;
  }

  async function destroy(): Promise<void> {
    await teardown();
    await ctx?.close();
    ctx = null;
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
    clearFile,
    loadedFileName,
    destroy,
  };
}
