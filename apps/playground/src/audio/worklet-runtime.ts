// AudioWorklet runtime that hosts unworklet processors.
// This module is bundled by esbuild into a single self-contained JS file
// and registered with audioContext.audioWorklet.addModule().
//
// All registered processors are bundled together; main thread picks one by
// name when constructing the AudioWorkletNode.

import { Engine } from "@unworklet/core/internal";
import type { CompiledProcessor, MidiEvent } from "@unworklet/core";

import { stereoGain } from "../../../../examples/src/01-stereo-gain.js";
import { threeBandEQ } from "../../../../examples/src/02-three-band-eq.js";
import { linearPhaseEQ } from "../../../../examples/src/03-linear-phase-eq.js";
import { lookaheadLimiter } from "../../../../examples/src/04-lookahead-limiter.js";
import { granularSampler } from "../../../../examples/src/05-granular-sampler.js";
import { arpeggiator } from "../../../../examples/src/06-arpeggiator.js";
import { convolutionReverb } from "../../../../examples/src/07-convolution-reverb.js";
import { polySynth } from "../../../../examples/src/08-poly-synth.js";
// Additional showcases
import { feedbackDelay } from "../../../../examples/src/09-feedback-delay.js";
import { chorus } from "../../../../examples/src/10-chorus.js";
import { distortion } from "../../../../examples/src/11-distortion.js";
import { drumSampler } from "../../../../examples/src/12-drum-sampler.js";
import { compressor } from "../../../../examples/src/13-compressor.js";
import { fmSynth } from "../../../../examples/src/14-fm-synth.js";

const REGISTRY: Record<string, CompiledProcessor> = {
  stereoGain,
  threeBandEQ,
  linearPhaseEQ,
  lookaheadLimiter,
  granularSampler,
  arpeggiator,
  convolutionReverb,
  polySynth,
  feedbackDelay,
  chorus,
  distortion,
  drumSampler,
  compressor,
  fmSynth,
};

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: new (...args: any[]) => AudioWorkletProcessor,
): void;

// Helper: extract parameterDescriptors from a CompiledProcessor by running its
// body once with a minimal Engine (sampleRate from worklet global).
function extractParamDescriptors(processor: CompiledProcessor): Array<{
  name: string;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: "a-rate" | "k-rate";
}> {
  const probe = new Engine(processor, { sampleRate, blockSize: 128 });
  return probe.rt.params.map((p) => ({
    name: p.slot.name,
    defaultValue: p.slot.default,
    minValue: p.slot.min,
    maxValue: p.slot.max,
    automationRate: p.slot.automationRate,
  }));
}

// Helper: get the I/O port shapes (number of channels per port) without
// rendering anything.
function extractIOShape(processor: CompiledProcessor): {
  inputs: Array<{ name: string; channels: number }>;
  outputs: Array<{ name: string; channels: number }>;
} {
  const probe = new Engine(processor, { sampleRate, blockSize: 128 });
  return {
    inputs: probe.rt.audioInputs.map((a) => ({
      name: a.slot.name,
      channels: a.slot.channels,
    })),
    outputs: probe.rt.audioOutputs.map((a) => ({
      name: a.slot.name,
      channels: a.slot.channels,
    })),
  };
}

// Each processor is registered as its own AudioWorkletProcessor class with
// the right parameterDescriptors. We synthesize the class dynamically per
// processor so AudioParam wiring works.
function makeProcessorClass(processor: CompiledProcessor) {
  const paramDescs = extractParamDescriptors(processor);
  const ioShape = extractIOShape(processor);

  return class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return paramDescs;
    }

    engine: Engine;
    paramArrays: Record<string, Float32Array | number> = {};
    inputBuffers: Record<string, Float32Array[]>;

    constructor() {
      super();
      this.engine = new Engine(processor, { sampleRate, blockSize: 128 });
      this.inputBuffers = {};
      for (const ai of this.engine.rt.audioInputs) {
        const bufs: Float32Array[] = [];
        for (let c = 0; c < ai.slot.channels; c++) {
          bufs.push(new Float32Array(128));
        }
        this.inputBuffers[ai.slot.name] = bufs;
      }
      this.port.onmessage = (e: MessageEvent) => this._handleMessage(e.data);
      // Send ready + I/O shape to main
      this.port.postMessage({
        type: "ready",
        ioShape,
        paramDescs,
        params: this.engine.rt.params.map((p) => ({
          name: p.slot.name,
          default: p.slot.default,
          min: p.slot.min,
          max: p.slot.max,
          automationRate: p.slot.automationRate,
        })),
        publishedSlots: this._listPublishedSlots(),
        events: this.engine.rt.events.map((e) => e.slot.name),
        messages: this.engine.rt.messages.map((m) => m.slot.name),
        midiInputs: this.engine.rt.midiInputs.map((m) => m.slot.name),
        midiOutputs: this.engine.rt.midiOutputs.map((m) => m.slot.name),
      });
    }

    _listPublishedSlots() {
      const out: Array<{ kind: "state" | "buffer"; path: string; name?: string; type?: string; size?: number }> = [];
      for (const scope of this.engine.rt.allScopes) {
        for (const sr of scope.states) {
          if (sr.slot.publish)
            out.push({
              kind: "state",
              path: sr.slot.path,
              name: sr.slot.name,
              type: sr.slot.type,
            });
        }
        for (const br of scope.buffers) {
          if (br.slot.publish)
            out.push({
              kind: "buffer",
              path: br.slot.path,
              name: br.slot.name,
              type: br.slot.type,
              size: br.slot.size,
            });
        }
      }
      return out;
    }

    _handleMessage(msg: any) {
      switch (msg.type) {
        case "message":
          this.engine.postMessage(msg.name, msg.payload);
          break;
        case "midi": {
          const midiName = this.engine.rt.midiInputs[0]?.slot.name;
          if (midiName) this.engine.postMidiEvent(midiName, msg.event as MidiEvent);
          break;
        }
        case "snapshot": {
          const blob = this.engine.snapshot(msg.profile);
          this.port.postMessage({ type: "snapshot-response", id: msg.id, blob });
          break;
        }
        case "restore": {
          const r = this.engine.restore(msg.blob);
          this.port.postMessage({ type: "restore-response", id: msg.id, result: r });
          break;
        }
      }
    }

    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean {
      const block = 128;
      // Marshal inputs (positional ports map to declared inputs in declaration order)
      const inputNames = this.engine.rt.audioInputs.map((a) => a.slot.name);
      for (let p = 0; p < inputNames.length; p++) {
        const name = inputNames[p]!;
        const declaredCh = this.engine.rt.audioInputs[p]!.slot.channels;
        const bufs = this.inputBuffers[name]!;
        const inSrc = inputs[p];
        for (let c = 0; c < declaredCh; c++) {
          const b = bufs[c]!;
          const src = inSrc?.[c];
          if (src && src.length > 0) {
            b.set(src);
            if (src.length < block) b.fill(0, src.length);
          } else {
            // If the source has fewer channels than declared, repeat last available channel
            const fallback = inSrc?.[inSrc.length - 1];
            if (fallback && fallback.length > 0) {
              b.set(fallback);
              if (fallback.length < block) b.fill(0, fallback.length);
            } else {
              b.fill(0);
            }
          }
        }
      }
      // Marshal params for engine
      for (const p of this.engine.rt.params) {
        const arr = parameters[p.slot.name];
        if (!arr) continue;
        if (p.slot.automationRate === "a-rate") {
          if (arr.length === 1) {
            this.paramArrays[p.slot.name] = arr[0]!;
          } else {
            this.paramArrays[p.slot.name] = arr;
          }
        } else {
          this.paramArrays[p.slot.name] = arr[0]!;
        }
      }

      const result = this.engine.render(this.inputBuffers, this.paramArrays);

      // Marshal outputs (positional)
      const outputNames = this.engine.rt.audioOutputs.map((a) => a.slot.name);
      for (let p = 0; p < outputNames.length; p++) {
        const name = outputNames[p]!;
        const dst = outputs[p];
        if (!dst) continue;
        const src = result.outputs[name];
        if (!src) continue;
        for (let c = 0; c < dst.length && c < src.length; c++) {
          dst[c]!.set(src[c]!);
        }
      }

      // Forward outbound events
      let hasEvents = false;
      const eventsOut: Record<string, Array<{ atSample: number; payload: any }>> = {};
      for (const [name, list] of result.events) {
        if (list.length > 0) {
          eventsOut[name] = list;
          hasEvents = true;
        }
      }
      if (hasEvents) this.port.postMessage({ type: "events", events: eventsOut });
      if (result.midiOut.length > 0)
        this.port.postMessage({ type: "midi-out", events: result.midiOut });

      // Forward published state values
      const pub: Record<string, any> = {};
      let hasPub = false;
      for (const [path, value] of this.engine.rt.publishLastValues) {
        // Send only those that changed since last frame
        // (we use a per-class shadow map)
        if (this._shadow.get(path) !== value) {
          // For typed arrays, transfer a copy
          if (
            value instanceof Float32Array ||
            value instanceof Int32Array ||
            value instanceof Float64Array
          ) {
            pub[path] = value.slice();
          } else {
            pub[path] = value;
          }
          this._shadow.set(path, value);
          hasPub = true;
        }
      }
      if (hasPub) this.port.postMessage({ type: "publish", values: pub });

      return true;
    }

    _shadow: Map<string, any> = new Map();
  };
}

// Persist diagnostics on globalThis so the page can fetch them later via a
// special "ping" processor.
const _registered: string[] = [];
const _failures: Array<{ name: string; error: string }> = [];

for (const [name, processor] of Object.entries(REGISTRY)) {
  try {
    registerProcessor(`uw:${name}`, makeProcessorClass(processor));
    _registered.push(name);
  } catch (e: any) {
    _failures.push({ name, error: String(e?.message ?? e) });
  }
}

// Register a diagnostics processor that, on construction, posts the registry
// status. The main thread can instantiate `uw:__diag` to verify the worklet ran.
class DiagProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.postMessage({
      type: "diag",
      registered: _registered,
      failures: _failures,
    });
  }
  process() {
    return true;
  }
}
registerProcessor("uw:__diag", DiagProcessor);
