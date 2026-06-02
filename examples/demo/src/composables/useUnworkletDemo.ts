// The demo's audio engine. Compiles a `.uwk.ts` source in the browser, wires the
// resulting node to the speakers, and supports live recompile (replaceProcessor +
// a short crossfade) and headless offline render. Effects process an input
// signal (a sawtooth, or a file you load); instruments are played via MIDI.
import { createNode, replaceProcessor } from "@unworklet/core";
import type { UnworkletNode } from "@unworklet/core";
import { ref } from "vue";

import type { Example } from "../examples.ts";
import { compileSource } from "@unworklet/lang/browser";

const FADE = 0.08;
const MASTER = 0.9;

export function useUnworkletDemo() {
  const status = ref<string>("idle");
  const error = ref<string | null>(null);
  const playing = ref(false);
  const busy = ref(false);

  let ctx: AudioContext | null = null;
  let node: UnworkletNode<unknown> | null = null;
  let master: GainNode | null = null;
  let source: AudioBufferSourceNode | OscillatorNode | null = null;
  let fileBuffer: AudioBuffer | null = null;
  let current: Example | null = null;

  const ensureCtx = async (): Promise<AudioContext> => {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    return ctx;
  };

  const makeSource = (c: AudioContext): AudioBufferSourceNode | OscillatorNode => {
    if (fileBuffer) {
      const s = c.createBufferSource();
      s.buffer = fileBuffer;
      s.loop = true;
      return s;
    }
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = 110;
    return o;
  };

  const watchErrors = (n: UnworkletNode<unknown>): void => {
    n.onError((e) => {
      error.value = `worklet error: ${JSON.stringify(e)}`;
    });
  };

  async function load(ex: Example): Promise<void> {
    // Create + resume the AudioContext FIRST, before any other await. iOS Safari
    // only honours `resume()` when it runs synchronously inside the user gesture;
    // deferring it past an await leaves the context silently un-started ("ready"
    // but no sound), even though desktop Chrome is lenient about the timing.
    const c = await ensureCtx();
    await teardown();
    current = ex;
    busy.value = true;
    error.value = null;
    status.value = "compiling…";
    try {
      node = await createNode(c, await compileSource(ex.source));
      master = c.createGain();
      master.gain.value = MASTER;
      node.outputs["main"]!.connect(master);
      master.connect(c.destination);
      watchErrors(node);
      // The compile + handshake can outlive the gesture window; nudge iOS again.
      if (c.state === "suspended") await c.resume();
      status.value = "ready";
    } catch (e) {
      error.value = String(e);
      status.value = "compile failed";
    } finally {
      busy.value = false;
    }
  }

  function play(): void {
    if (!ctx || !node || playing.value) return;
    if (ctx.state === "suspended") void ctx.resume(); // iOS: keep the context awake on the tap
    if (current?.kind === "effect") {
      source = makeSource(ctx);
      source.connect(node.inputs["main"]!);
      source.start();
    }
    playing.value = true;
  }

  function stop(): void {
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
      source = null;
    }
    playing.value = false;
  }

  // Debug isolation: a plain Web Audio oscillator on the same context, built
  // fully synchronously inside the tap. If this is silent where an unworklet node
  // is too, the AudioContext itself isn't producing sound (gesture / device); if
  // it beeps, the context is fine and the worklet path is the suspect.
  function testTone(): void {
    ctx ??= new AudioContext();
    void ctx.resume();
    const c = ctx;
    const osc = c.createOscillator();
    const g = c.createGain();
    g.gain.value = 0.2;
    osc.frequency.value = 440;
    osc.connect(g);
    g.connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.4);
  }

  function playNote(note: number): void {
    if (ctx && ctx.state === "suspended") void ctx.resume(); // iOS: the note tap is a gesture
    const port = current?.midiPort ? node?.midi[current.midiPort] : undefined;
    if (!port) return;
    port.send({ type: "noteOn", channel: 0, note, velocity: 100 });
    window.setTimeout(() => port.send({ type: "noteOff", channel: 0, note, velocity: 0 }), 400);
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
      window.setTimeout(
        () => {
          oldMaster.disconnect();
          oldNode.dispose();
        },
        FADE * 1000 + 80,
      );
      status.value = `recompiled (carried: ${r.applied.join(", ") || "—"})`;
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
    if (playing.value && current?.kind === "effect") {
      stop();
      play();
    }
  }

  async function teardown(): Promise<void> {
    stop();
    node?.dispose();
    node = null;
    master?.disconnect();
    master = null;
  }

  return {
    status,
    error,
    playing,
    busy,
    load,
    play,
    stop,
    testTone,
    playNote,
    recompile,
    loadFile,
    teardown,
  };
}
