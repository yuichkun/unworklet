/**
 * Golden cases for the issue #10 rename invariance oracle.
 *
 * A curated set of processors that, together, exercise the entire authoring
 * surface the rename touches — every scalar/buffer type, every declaration
 * (state / buffer / param / event / message / midiInput / midiOutput / audio),
 * every access method (load/store, read/write/readInterpolated/copyFrom, emitIf,
 * onReceive, onEvent, loadVec), plus subgraphs, SIMD, snapshot, and migration.
 *
 * Authored on the CURRENT (pre-rename) surface. During Phase A the authoring
 * lines here get rewritten to the new surface, but the committed fingerprints
 * (`./fixtures/*.json`) stay frozen — proving the compiled IR is unchanged.
 */

import {
  audioInput,
  audioOutput,
  buffer,
  createSubgraph,
  defineProcessor,
  defineSubgraph,
  event,
  f32,
  forSample,
  message,
  midiInput,
  midiOutput,
  num,
  param,
  select,
  state,
  type Node,
  type State,
} from "@unworklet/core";
import { mulVec, splat, sumLanes } from "@unworklet/core/simd";

import type { GoldenCase } from "./fingerprint.ts";

// ── scalar state: every type + publish + snapshot + named ────────────────────
const allScalarStates = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const sf32 = state
    .f32(0.5)
    .named("sf32")
    .expose({ publish: { rateFps: 30 }, snapshot: "persistent" });
  const sf64 = state.f64(1).named("sf64").expose({ snapshot: "persistent" });
  const si32 = state
    .i32(7)
    .named("si32")
    .expose({ publish: { rateFps: 60 } });
  const si64 = state.i64(9n).named("si64").expose({ snapshot: "persistent" });
  const sbool = state
    .bool(true)
    .named("sbool")
    .expose({ publish: { rateFps: 15 } });
  return {
    process: () => {
      forSample((i) => {
        sf32.write(sf32.read().mul(0.999).add(0.001));
        si32.write(si32.read().add(1).mod(128));
        sbool.write(si32.read().gt(64));
        out
          .ch(0)
          .at(i)
          .write(select(sbool.read(), sf32.read(), num(0)));
      });
      sf64.write(sf64.read().add(num(1)));
      si64.write(si64.read());
    },
  };
});

// ── buffer: every element type + read/write/readInterpolated + publish ───────
const allBufferTypes = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "in" });
  const out = audioOutput({ channels: 1, name: "out" });
  const bf32 = buffer.f32({ size: 16 }).named("bf32").expose({ snapshot: "persistent" });
  const bf64 = buffer.f64({ size: 8 }).named("bf64");
  const bi32 = buffer.i32({ size: 8 }).named("bi32");
  const bi64 = buffer.i64({ size: 8 }).named("bi64");
  const bbool = buffer.bool({ size: 8 }).named("bbool");
  const bu8 = buffer
    .u8({ size: 8 })
    .named("bu8")
    .expose({ publish: { rateFps: 30 } });
  const head = state.i32(0).named("head");
  return {
    process: () => {
      bi32.write(0, 11);
      bf64.write(0, 3);
      bbool.write(0, 1);
      bu8.write(0, 255);
      const h = head.read();
      forSample((i) => {
        bf32.write(h.add(i).mod(16), input.ch(0).at(i));
        const interp = bf32.readInterpolated(num(1.5));
        const mix = interp
          .add(f32(bi32.read(0)))
          .add(f32(bf64.read(0)))
          .add(f32(bi64.read(0)))
          .add(f32(bu8.read(0)))
          .add(select(bbool.read(0), num(1), num(0)));
        out.ch(0).at(i).write(mix.mul(0.001));
      });
      head.write(h.add(128).mod(16));
    },
  };
});

// ── audio I/O (mono + stereo sugar) + param (a/k-rate) + loop variants ────────
const audioParamLoops = defineProcessor(() => {
  const stereoIn = audioInput({ channels: 2, name: "stereo" });
  const stereoOut = audioOutput({ channels: 2, name: "stereo" });
  const gain = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" }).named("gain");
  const tilt = param.f32({ default: 0, min: -1, max: 1, automationRate: "k-rate" }).named("tilt");
  const tick = state.i32(0).named("tick");
  return {
    process: () => {
      forSample((i) => {
        stereoOut.left.at(i).write(stereoIn.left.at(i).mul(gain.at(i)));
        stereoOut.right.at(i).write(stereoIn.right.at(i).mul(gain.at(i)).add(tilt.at(0)));
      });
      forSample.byN(4, (i) => {
        tick.write(tick.read().add(1));
        stereoOut.left.at(i).write(stereoIn.left.at(i).mul(0.5));
      });
    },
  };
});

// ── event<T> (worklet→main): scalar fields + atSample ─────────────────────────
const eventScalar = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "in" });
  const out = audioOutput({ channels: 1, name: "out" });
  const peakEv = event<{ level: number; loud: boolean }>({ name: "peak" });
  const env = state.f32(0).named("env");
  return {
    process: () => {
      forSample((i) => {
        const x = input.ch(0).at(i).abs();
        env.write(x.sub(env.read()).mul(0.01).add(env.read()));
        out.ch(0).at(i).write(input.ch(0).at(i));
        peakEv.emitIf(x.gt(0.5), { atSample: i, level: x, loud: x.gt(0.9) });
      });
    },
  };
});

// ── event<T> (worklet→main): variable-length Float32Array field ──────────────
const eventTypedArray = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "in" });
  const out = audioOutput({ channels: 1, name: "out" });
  const scope = event<{ samples: Float32Array }>({ name: "scope" });
  const ring = buffer.f32({ size: 16 });
  return {
    process: () => {
      forSample((i) => {
        ring.write(i.mod(16), input.ch(0).at(i));
        out.ch(0).at(i).write(input.ch(0).at(i));
      });
      scope.emitIf(true, { samples: ring, length: 16 });
    },
  };
});

// ── message<T> (main→worklet): scalar fields ─────────────────────────────────
const messageScalar = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const ctrl = message<{ gain: number; on: boolean }>({ name: "ctrl" });
  const g = state.f32(1).named("g");
  const on = state.bool(true).named("on");
  return {
    process: () => {
      ctrl.onReceive(({ gain, on: onv }) => {
        g.write(f32(gain));
        on.write(onv);
      });
      forSample((i) => {
        out
          .ch(0)
          .at(i)
          .write(select(on.read(), g.read(), num(0)));
      });
    },
  };
});

// ── message<T> (main→worklet): Float32Array field + copyFrom into a buffer ────
const messageTypedArray = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const table = buffer.f32({ size: 16 }).named("table").expose({ snapshot: "persistent" });
  const upload = message<{ data: Float32Array }>({ name: "upload" });
  const idx = state.i32(0).named("idx");
  return {
    process: () => {
      upload.onReceive(({ data }) => {
        table.copyFrom(data);
      });
      forSample((i) => {
        out.ch(0).at(i).write(table.read(idx.read()).mul(0.001));
      });
      idx.write(idx.read().add(1).mod(16));
    },
  };
});

// ── midiInput: every inbound event type + sysex copyFrom ─────────────────────
const allMidiIn = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const port = midiInput({ name: "in" });
  const acc = state.i32(0).named("acc");
  const sysbuf = buffer.u8({ size: 64 }).named("sysbuf");
  return {
    process: () => {
      port.onEvent("noteOn", ({ note, velocity, channel }) => {
        acc.write(acc.read().add(note).add(velocity).add(channel));
      });
      port.onEvent("noteOff", ({ note, velocity }) => {
        acc.write(acc.read().add(note).sub(velocity));
      });
      port.onEvent("cc", ({ controller, value }) => {
        acc.write(acc.read().add(controller).add(value));
      });
      port.onEvent("pitchBend", ({ value }) => {
        acc.write(acc.read().add(value));
      });
      port.onEvent("programChange", ({ program }) => {
        acc.write(acc.read().add(program));
      });
      port.onEvent("channelPressure", ({ pressure }) => {
        acc.write(acc.read().add(pressure));
      });
      port.onEvent("aftertouch", ({ note, pressure }) => {
        acc.write(acc.read().add(note).add(pressure));
      });
      port.onEvent("systemRealtime", ({ status }) => {
        acc.write(acc.read().add(status));
      });
      port.onEvent("sysex", ({ data, length }) => {
        sysbuf.copyFrom(data);
        acc.write(acc.read().add(length));
      });
      forSample((i) => {
        out.ch(0).at(i).write(num(0));
      });
    },
  };
});

// ── midiOutput: every outbound event type + sysex from a buffer.u8 ───────────
const allMidiOut = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "out" });
  const port = midiOutput({ name: "out" });
  const sysbuf = buffer.u8({ size: 8 }).named("sysbuf");
  return {
    process: () => {
      forSample((i) => {
        out.ch(0).at(i).write(num(0));
        const fire = i.eq(0);
        port.emitIf(fire, { type: "noteOn", atSample: i, channel: 0, note: 60, velocity: 100 });
        port.emitIf(fire, { type: "noteOff", atSample: i, channel: 0, note: 60, velocity: 0 });
        port.emitIf(fire, { type: "cc", atSample: i, channel: 0, controller: 7, value: 100 });
        port.emitIf(fire, { type: "pitchBend", atSample: i, channel: 0, value: 8192 });
        port.emitIf(fire, { type: "programChange", atSample: i, channel: 0, program: 5 });
        port.emitIf(fire, { type: "channelPressure", atSample: i, channel: 0, pressure: 64 });
        port.emitIf(fire, { type: "aftertouch", atSample: i, channel: 0, note: 60, pressure: 32 });
        port.emitIf(fire, { type: "systemRealtime", atSample: i, status: 0xf8 });
        port.emitIf(fire, { type: "sysex", atSample: i, data: sysbuf, length: 8 });
      });
    },
  };
});

// ── Integration: lookahead limiter (param + buffer.f32 + event + envelope) ────
const limiter = defineProcessor((ctx) => {
  const LOOKAHEAD = 32;
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const ceiling = param
    .f32({ default: 0.5, min: 0, max: 1, automationRate: "k-rate" })
    .named("ceiling");
  const dly = buffer.f32({ size: LOOKAHEAD });
  const dlyHead = state.i32(0);
  const env = state.f32(0);
  const overshoot = event<{ level: number }>({ name: "overshoot" });
  return {
    process: () => {
      const relCoef = num(1).sub(
        num(-1)
          .div(num(0.05 * ctx.sampleRate))
          .exp(),
      );
      const headBlock = dlyHead.read();
      forSample((i) => {
        const x = input.ch(0).at(i);
        const peak = x.abs();
        env.write(peak.sub(env.read()).mul(relCoef).add(env.read()));
        const wIdx = headBlock.add(i).mod(LOOKAHEAD);
        dly.write(wIdx, x);
        out
          .ch(0)
          .at(i)
          .write(dly.read(wIdx.add(1).mod(LOOKAHEAD)));
        overshoot.emitIf(peak.gt(ceiling.at(0)), { atSample: i, level: peak });
      });
      dlyHead.write(headBlock.add(128).mod(LOOKAHEAD));
    },
  };
});

// ── Integration: SIMD convolution reverb (subgraph-free, SIMD + snapshot + migration) ─
const IR_LEN = 16;
const reverb = defineProcessor(
  () => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const ir = buffer.f32({ size: IR_LEN }).expose({ name: "ir", snapshot: "persistent" });
    const hist = buffer.f32({ size: IR_LEN });
    const histHead = state.i32(0);
    const uploadIR = message<{ ir: Float32Array }>({ name: "uploadIR" });
    return {
      process: () => {
        uploadIR.onReceive(({ ir: incoming }) => {
          ir.copyFrom(incoming);
        });
        const headBlock = histHead.read();
        forSample((i) => {
          hist.write(headBlock.add(i).mod(IR_LEN), input.ch(0).at(i));
        });
        forSample.byN(4, (i) => {
          const outIdx = headBlock.add(i).mod(IR_LEN);
          let acc = splat(num(0));
          for (let k = 0; k < IR_LEN; k += 4) {
            const histIdx = outIdx.sub(k).sub(3).add(IR_LEN).mod(IR_LEN);
            acc = acc.add(mulVec(hist.loadVec(histIdx), ir.loadVec(k)));
          }
          out.ch(0).at(i).write(sumLanes(acc));
        });
        histHead.write(headBlock.add(128).mod(IR_LEN));
      },
    };
  },
  {
    migrations: [
      {
        from: "MONOIRHASH00000",
        to: "DUMMYTARGET0000",
        migrate: (blob, h) => {
          const mono = h.parseBuffer(blob, "irMono", "f32");
          if (mono) h.writeBuffer("ir", "f32", mono);
        },
      },
    ],
  },
);

// ── Integration: multi-instance biquad subgraph (state feedback + CSE) ────────
function biquadDFIIT(
  x: Node<"f32">,
  b0: Node<"f32">,
  z1: State<"f32">,
  z2: State<"f32">,
): Node<"f32"> {
  const y = b0.mul(x).add(z1.read());
  z1.write(z2.read().sub(y));
  z2.write(b0.mul(x).sub(y));
  return y;
}
const peakingBand = defineSubgraph((_sr: number) => {
  const z1 = state.f32(0);
  const z2 = state.f32(0);
  return {
    process: (input: Node<"f32">, b0: Node<"f32">) => biquadDFIIT(input, b0, z1, z2),
  };
});
const subgraphEq = defineProcessor((ctx) => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const low = createSubgraph(peakingBand, ctx.sampleRate);
  const hi = createSubgraph(peakingBand, ctx.sampleRate);
  return {
    process: () => {
      forSample((i) => {
        const x = input.ch(0).at(i);
        out
          .ch(0)
          .at(i)
          .write(hi.process(low.process(x, num(1)), num(1)));
      });
    },
  };
});

const ZERO_128 = new Float32Array(128);

export const CASES: GoldenCase[] = [
  {
    name: "allScalarStates",
    processor: allScalarStates,
    config: { sampleRate: 48000, duration: 128 / 48000 },
  },
  {
    name: "allBufferTypes",
    processor: allBufferTypes,
    config: { sampleRate: 48000, duration: 128 / 48000, inputs: { in: [ZERO_128] } },
  },
  {
    name: "audioParamLoops",
    processor: audioParamLoops,
    config: {
      sampleRate: 48000,
      duration: 128 / 48000,
      inputs: { stereo: [ZERO_128, ZERO_128] },
      params: { gain: [0.5], tilt: [0] },
    },
  },
  {
    name: "eventScalar",
    processor: eventScalar,
    config: { sampleRate: 48000, duration: 128 / 48000, inputs: { in: [ZERO_128] } },
  },
  {
    name: "eventTypedArray",
    processor: eventTypedArray,
    config: { sampleRate: 48000, duration: 128 / 48000, inputs: { in: [ZERO_128] } },
  },
  {
    name: "messageScalar",
    processor: messageScalar,
    config: {
      sampleRate: 48000,
      duration: 128 / 48000,
      messages: [{ name: "ctrl", payload: { gain: 2, on: true }, atQuantum: 0 }],
    },
  },
  {
    name: "messageTypedArray",
    processor: messageTypedArray,
    config: {
      sampleRate: 48000,
      duration: 128 / 48000,
      messages: [
        { name: "upload", payload: { data: new Float32Array(16).fill(0.25) }, atQuantum: 0 },
      ],
    },
  },
  {
    name: "allMidiIn",
    processor: allMidiIn,
    config: {
      sampleRate: 48000,
      duration: 128 / 48000,
      events: [
        {
          name: "in",
          payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
          atSample: 0,
        },
        { name: "in", payload: { type: "cc", channel: 0, controller: 7, value: 64 }, atSample: 10 },
      ],
    },
  },
  {
    name: "allMidiOut",
    processor: allMidiOut,
    config: { sampleRate: 48000, duration: 128 / 48000 },
  },
  {
    name: "limiter",
    processor: limiter,
    config: {
      sampleRate: 48000,
      duration: 128 / 48000,
      inputs: { main: [new Float32Array(128).fill(0.2)] },
      params: { ceiling: [0.5] },
    },
  },
  {
    name: "reverb",
    processor: reverb,
    config: {
      sampleRate: 48000,
      duration: 128 / 48000,
      inputs: { main: [new Float32Array(128).fill(0.3)] },
      messages: [
        { name: "uploadIR", payload: { ir: new Float32Array(IR_LEN).fill(0.1) }, atQuantum: 0 },
      ],
    },
  },
  {
    name: "subgraphEq",
    processor: subgraphEq,
    config: { sampleRate: 48000, duration: 128 / 48000, inputs: { main: [ZERO_128] } },
  },
];
