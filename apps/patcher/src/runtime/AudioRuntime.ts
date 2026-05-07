// AudioRuntime: takes a Patch, compiles it, and runs it inside an
// AudioWorkletNode. On every patch change we double-buffer: the new node
// is created behind a GainNode at gain=0; we ramp old → 0 and new → 1
// over 50 ms simultaneously, then dispose the old after the fade.
//
// This is the standard click-free hot-swap pattern; 50 ms is long enough
// to mask discontinuities in oscillator phase / filter state but short
// enough to feel instant.

import { createWasmNode, type WasmUnworkletNode } from "@unworklet/worklet";
import type { CompiledProcessor } from "@unworklet/core";
import { patchToProcessor, type CompileResult } from "../compiler/compile";
import type { Patch } from "../types";

const FADE_SECONDS = 0.05;

type Slot = {
  node: WasmUnworkletNode;
  gain: GainNode;
  paramRouting: Record<string, string>;
};

export class AudioRuntime {
  ctx: AudioContext | null = null;
  micSource: MediaStreamAudioSourceNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterAnalyserData: Float32Array | null = null;
  private current: Slot | null = null;
  private compileSeq = 0;
  /** Listeners notified when the live processor changes (e.g. for state / scope subscribers). */
  private listeners = new Set<(node: WasmUnworkletNode | null) => void>();

  /** Lazy-init the AudioContext on first user gesture. */
  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000 });
      // A master analyser sits between every patch's master gain and
      // ctx.destination so the UI can show a peak meter independent of
      // whether the patch has its own meter~ node.
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 1024;
      this.masterAnalyserData = new Float32Array(this.masterAnalyser.fftSize);
      this.masterAnalyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  /** Read the latest master peak (|x|) — for the UI master VU. */
  getMasterPeak(): number {
    if (!this.masterAnalyser || !this.masterAnalyserData) return 0;
    this.masterAnalyser.getFloatTimeDomainData(this.masterAnalyserData);
    let p = 0;
    for (let i = 0; i < this.masterAnalyserData.length; i++) {
      const v = Math.abs(this.masterAnalyserData[i]!);
      if (v > p) p = v;
    }
    return p;
  }

  /** Optionally request the microphone (for `adc~`). Idempotent. */
  async ensureMic(): Promise<MediaStreamAudioSourceNode | null> {
    if (this.micSource) return this.micSource;
    if (!this.ctx) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micSource = this.ctx.createMediaStreamSource(stream);
      // If a current node is live, wire it.
      if (this.current && this.current.node.inputs.main) {
        this.micSource.connect(this.current.node.inputs.main.node);
      }
      return this.micSource;
    } catch {
      return null;
    }
  }

  onProcessorChange(fn: (node: WasmUnworkletNode | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Compile + swap. Returns the new compile result. */
  async swap(patch: Patch): Promise<CompileResult> {
    const ctx = await this.ensureContext();
    let compiled: CompileResult;
    try {
      compiled = patchToProcessor(patch);
    } catch (e: any) {
      console.error("[patcher] patchToProcessor failed:", e?.message, e?.stack);
      throw e;
    }

    const seq = ++this.compileSeq;
    const procName = `patch_v${seq}`;
    let nextNode: WasmUnworkletNode;
    try {
      nextNode = await createWasmNode(ctx, compiled.processor, procName);
    } catch (e: any) {
      console.error("[patcher] createWasmNode failed:", e?.message, e?.stack);
      throw e;
    }

    // If a newer compile already started, abort this one.
    if (seq !== this.compileSeq) {
      try { nextNode.dispose(); } catch {}
      throw new Error("Stale compile (newer swap superseded).");
    }

    const nextGain = ctx.createGain();
    nextGain.gain.value = 0;

    // Wire next: each declared dac~ output → nextGain → masterAnalyser → destination.
    // (The patch's IO names follow our compiler's convention: `out_${nodeId}`.)
    for (const k of Object.keys(nextNode.outputs)) {
      // Skip the legacy __out_<idx> aliases — connect via the named ones only.
      if (k.startsWith("__out_")) continue;
      try { nextNode.outputs[k].connect(nextGain); } catch {}
    }
    if (this.masterAnalyser) nextGain.connect(this.masterAnalyser);
    else nextGain.connect(ctx.destination);

    // Wire microphone if the patch has an adc~ input.
    if (this.micSource) {
      for (const k of Object.keys(nextNode.inputs)) {
        if (k.startsWith("__in_")) continue;
        try { this.micSource.connect(nextNode.inputs[k].node); } catch {}
      }
    }

    // Apply initial param values from the patch (slider / dial defaults).
    for (const [paramName, nodeId] of Object.entries(compiled.paramRouting)) {
      const patchNode = patch.nodes.find((n) => n.id === nodeId);
      if (!patchNode) continue;
      const v = patchNode.attrs?.value;
      if (typeof v === "number" && nextNode.params[paramName]) {
        nextNode.params[paramName].value = v;
      }
    }

    // Crossfade.
    const t = ctx.currentTime;
    nextGain.gain.setValueAtTime(0, t);
    nextGain.gain.linearRampToValueAtTime(1, t + FADE_SECONDS);

    const old = this.current;
    if (old) {
      old.gain.gain.setValueAtTime(1, t);
      old.gain.gain.linearRampToValueAtTime(0, t + FADE_SECONDS);
      setTimeout(() => {
        try {
          old.node.dispose();
          old.gain.disconnect();
        } catch {}
      }, FADE_SECONDS * 1000 + 30);
    }

    this.current = {
      node: nextNode,
      gain: nextGain,
      paramRouting: compiled.paramRouting,
    };

    for (const fn of this.listeners) fn(nextNode);

    return compiled;
  }

  /** Stop everything. Used when the user hits "Stop". */
  async stop() {
    if (this.current) {
      const ctx = this.ctx!;
      const t = ctx.currentTime;
      this.current.gain.gain.setValueAtTime(1, t);
      this.current.gain.gain.linearRampToValueAtTime(0, t + FADE_SECONDS);
      const old = this.current;
      this.current = null;
      setTimeout(() => {
        try {
          old.node.dispose();
          old.gain.disconnect();
        } catch {}
      }, FADE_SECONDS * 1000 + 30);
    }
    for (const fn of this.listeners) fn(null);
  }

  /** Update a single AudioParam by patch-node id (slider / dial drag). */
  setParam(nodeId: string, value: number) {
    if (!this.current) return;
    for (const [paramName, id] of Object.entries(this.current.paramRouting)) {
      if (id === nodeId) {
        const ap = this.current.node.params[paramName];
        if (ap) {
          // Use linear ramp so per-frame slider drags don't click.
          const t = (this.ctx?.currentTime ?? 0) + 0.005;
          ap.linearRampToValueAtTime(value, t);
        }
        return;
      }
    }
  }

  get currentNode(): WasmUnworkletNode | null {
    return this.current?.node ?? null;
  }
}
