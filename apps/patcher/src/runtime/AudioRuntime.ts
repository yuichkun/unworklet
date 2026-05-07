// AudioRuntime: takes a Patch, compiles it, and runs it inside an
// AudioWorkletNode. On every patch change we double-buffer: the new node
// is created behind a GainNode at gain=0; we ramp old → 0 and new → 1
// over 50 ms simultaneously, then dispose the old after the fade.
//
// This is the standard click-free hot-swap pattern; 50 ms is long enough
// to mask discontinuities in oscillator phase / filter state but short
// enough to feel instant.

import { createWasmNode, type WasmUnworkletNode } from "@unworklet/worklet";
import { patchToProcessor, type CompileResult, type ParamRoute, type MidiInputRoute, type MidiOutputRoute } from "../compiler/compile";
import type { Patch } from "../types";

const FADE_SECONDS = 0.05;

type Slot = {
  node: WasmUnworkletNode;
  gain: GainNode;
  paramRouting: Record<string, ParamRoute>;
  midiInputs: MidiInputRoute[];
  midiOutputs: MidiOutputRoute[];
  /** Disposers for any event-out subscriptions registered for this slot. */
  eventDisposers: Array<() => void>;
};

export class AudioRuntime {
  ctx: AudioContext | null = null;
  micSource: MediaStreamAudioSourceNode | null = null;
  midiAccess: MIDIAccess | null = null;
  midiInputs: MIDIInput[] = [];
  midiOutputs: MIDIOutput[] = [];
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
    for (const [pname, route] of Object.entries(compiled.paramRouting)) {
      const patchNode = patch.nodes.find((n) => n.id === route.nodeId);
      if (!patchNode) continue;
      const v = patchNode.attrs?.[route.spec.name] ?? patchNode.attrs?.value;
      if (typeof v === "number" && nextNode.params[pname]) {
        nextNode.params[pname].value = v;
      }
    }

    // Wire MIDI output: subscribe to published state slots (note/vel/gate
    // for note-out; value for cc-out; status for raw) and emit MIDI when
    // they transition. Edge detection and dedup live on the main thread
    // because the worklet just publishes raw values.
    const eventDisposers: Array<() => void> = [];
    for (const route of compiled.midiOutputs) {
      const channelByte = (route.channel - 1) & 0x0f;
      if (route.kind === "note") {
        let lastNote = 0, lastVel = 0, lastGate = 0;
        const noteSlot = nextNode.state[route.stateNames[0]!];
        const velSlot = nextNode.state[route.stateNames[1]!];
        const gateSlot = nextNode.state[route.stateNames[2]!];
        if (gateSlot?.subscribe) {
          const off = gateSlot.subscribe((g: number) => {
            const newGate = g >= 0.5 ? 1 : 0;
            if (newGate === lastGate) return;
            const note = Math.max(0, Math.min(127, Math.round((noteSlot?.value as number) ?? lastNote)));
            const vel = Math.max(0, Math.min(127, Math.round(((velSlot?.value as number) ?? lastVel) * 127)));
            for (const out of this.midiOutputs) {
              try {
                if (newGate === 1) out.send([0x90 | channelByte, note, vel || 1]);
                else out.send([0x80 | channelByte, note, 0]);
              } catch {}
            }
            lastGate = newGate;
            lastNote = note;
            lastVel = vel;
          });
          if (typeof off === "function") eventDisposers.push(off);
        }
      } else if (route.kind === "cc") {
        let lastVal = -1;
        const slot = nextNode.state[route.stateNames[0]!];
        if (slot?.subscribe) {
          const cc = (route.controller ?? 1) & 0x7f;
          const off = slot.subscribe((v: number) => {
            const intVal = Math.max(0, Math.min(127, Math.round(v * 127)));
            if (intVal === lastVal) return;
            lastVal = intVal;
            for (const out of this.midiOutputs) {
              try { out.send([0xb0 | channelByte, cc, intVal]); } catch {}
            }
          });
          if (typeof off === "function") eventDisposers.push(off);
        }
      } else {
        // raw: forward inlet 0 byte as-is when it changes
        let last = -1;
        const slot = nextNode.state[route.stateNames[0]!];
        if (slot?.subscribe) {
          const off = slot.subscribe((v: number) => {
            const b = Math.max(0, Math.min(255, Math.round(v))) & 0xff;
            if (b === last) return;
            last = b;
            for (const out of this.midiOutputs) {
              try { out.send([b]); } catch {}
            }
          });
          if (typeof off === "function") eventDisposers.push(off);
        }
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
          for (const off of old.eventDisposers) off();
          old.node.dispose();
          old.gain.disconnect();
        } catch {}
      }, FADE_SECONDS * 1000 + 30);
    }

    this.current = {
      node: nextNode,
      gain: nextGain,
      paramRouting: compiled.paramRouting,
      midiInputs: compiled.midiInputs,
      midiOutputs: compiled.midiOutputs,
      eventDisposers,
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

  /** Update a single AudioParam by patch-node id (slider / dial drag).
   *  When a node has multiple paramSpecs (kslider note+gate, notein note+vel+gate),
   *  pass `outletIndex` to target the right param. */
  setParam(nodeId: string, value: number, outletIndex: number = 0) {
    if (!this.current) return;
    for (const [pname, route] of Object.entries(this.current.paramRouting)) {
      if (route.nodeId === nodeId && route.outletIndex === outletIndex) {
        const ap = this.current.node.params[pname];
        if (ap) {
          // Use linear ramp so per-frame slider drags don't click.
          const t = (this.ctx?.currentTime ?? 0) + 0.005;
          ap.linearRampToValueAtTime(value, t);
        }
        return;
      }
    }
  }

  /** Open Web MIDI access (idempotent). After this resolves, the runtime
   *  forwards incoming MIDI events to matching `notein`/`ctlin`/`pitchbend`
   *  nodes in the live patch, and provides MIDIOutputs to `noteout` etc. */
  async ensureMidi(): Promise<MIDIAccess | null> {
    if (this.midiAccess) return this.midiAccess;
    if (typeof navigator === "undefined" || !navigator.requestMIDIAccess) return null;
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      return null;
    }
    const refresh = () => {
      this.midiInputs = Array.from(this.midiAccess!.inputs.values());
      this.midiOutputs = Array.from(this.midiAccess!.outputs.values());
      for (const inp of this.midiInputs) {
        inp.onmidimessage = (ev: MIDIMessageEvent) => this.handleMidiMessage(ev);
      }
    };
    refresh();
    this.midiAccess.onstatechange = refresh;
    return this.midiAccess;
  }

  private handleMidiMessage(ev: MIDIMessageEvent) {
    if (!this.current || !ev.data || ev.data.length === 0) return;
    const status = ev.data[0]!;
    const type = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const d1 = ev.data[1] ?? 0;
    const d2 = ev.data[2] ?? 0;
    for (const route of this.current.midiInputs) {
      if (route.channel != null && route.channel !== channel) continue;
      if (route.kind === "note" && (type === 0x90 || type === 0x80)) {
        const isOn = type === 0x90 && d2 > 0;
        // outlet 0 = note, 1 = velocity (0..1), 2 = gate (0/1)
        this.setParam(route.nodeId, d1, 0);
        this.setParam(route.nodeId, isOn ? d2 / 127 : 0, 1);
        this.setParam(route.nodeId, isOn ? 1 : 0, 2);
      } else if (route.kind === "cc" && type === 0xb0) {
        if (route.controller != null && route.controller !== d1) continue;
        // outlet 0 = value (0..1)
        this.setParam(route.nodeId, d2 / 127, 0);
      } else if (route.kind === "pitchbend" && type === 0xe0) {
        const raw = (d2 << 7) | d1; // 0..16383
        this.setParam(route.nodeId, (raw - 8192) / 8192, 0);
      }
    }
  }

  /** Synthesize a fake MIDI message into the live patch (test hook + in-app
   *  keyboard widgets use this to drive notein/ctlin from the UI). */
  injectMidi(bytes: number[]) {
    this.handleMidiMessage({
      data: new Uint8Array(bytes) as any,
      receivedTime: 0,
      timeStamp: 0,
    } as any);
  }

  get currentNode(): WasmUnworkletNode | null {
    return this.current?.node ?? null;
  }
}
