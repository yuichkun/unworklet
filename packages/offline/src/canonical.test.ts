/**
 * Canonical examples (`docs/12-canonical-examples.md`) driven end-to-end through
 * `renderOffline` — the integrity anchor + acceptance A2/B1. Each test ports a
 * realistic plugin and asserts behavioral correctness (compile success, stable
 * output, expected events/state), exercising the combined surface rather than
 * one primitive in isolation.
 */

import "@unworklet/core";
import {
  audioInput,
  audioOutput,
  createSubgraph,
  defineSubgraph,
  defineProcessor,
  event,
  forSample,
  i32,
  lt,
  message,
  midiInput,
  midiOutput,
  num,
  select,
  state,
  type Node,
  type State,
} from "@unworklet/core";
import { expect, test } from "vite-plus/test";

import { renderOffline } from "./index.ts";

test("ctx.sampleRate flows the host rate into build-time coefficient precomputation", async () => {
  // The processor bakes `ctx.sampleRate` into the output; compile re-captures at
  // the host rate, so the same processor yields rate-specific output.
  const proc = defineProcessor((ctx) => {
    const out = audioOutput({ channels: 1, name: "main" });
    const rate = ctx.sampleRate; // build-time JS number
    return {
      process: () => {
        forSample((i) => {
          out
            .ch(0)
            .at(i)
            .write(num(rate / 1000));
        });
      },
    };
  });
  const at44k = await renderOffline(proc, { sampleRate: 44100, duration: 128 / 44100 });
  const at48k = await renderOffline(proc, { sampleRate: 48000, duration: 128 / 48000 });
  expect(at44k.outputs.main![0]![0]).toBeCloseTo(44.1, 3);
  expect(at48k.outputs.main![0]![0]).toBeCloseTo(48, 3);
});

// ── Ex 2: three-band biquad EQ (validates CSE / state feedback, §12 Ex 2) ────

function biquadDFIIT(
  x: Node<"f32">,
  b0: Node<"f32">,
  b1: Node<"f32">,
  b2: Node<"f32">,
  a1: Node<"f32">,
  a2: Node<"f32">,
  z1: State<"f32">,
  z2: State<"f32">,
): Node<"f32"> {
  const y = b0.mul(x).add(z1.load());
  const z1n = b1.mul(x).add(z2.load()).sub(a1.mul(y));
  const z2n = b2.mul(x).sub(a2.mul(y));
  z1.store(z1n);
  z2.store(z2n);
  return y;
}

const peakingBand = defineSubgraph((_sr: number) => {
  const z1 = state.f32(0);
  const z2 = state.f32(0);
  return {
    process: (
      input: Node<"f32">,
      b0: Node<"f32">,
      b1: Node<"f32">,
      b2: Node<"f32">,
      a1: Node<"f32">,
      a2: Node<"f32">,
    ) => biquadDFIIT(input, b0, b1, b2, a1, a2, z1, z2),
  };
});

test("Ex2 biquad EQ: unity-coefficient cascade is a passthrough + stable", async () => {
  // With identity coeffs (b0=1, rest 0) each band is a passthrough; the cascade
  // returns the input. This validates the multi-instance subgraph + DF-II-T
  // state feedback compiles + runs correctly under the CSE fix.
  const eq = defineProcessor((ctx) => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const low = createSubgraph(peakingBand, ctx.sampleRate);
    const mid = createSubgraph(peakingBand, ctx.sampleRate);
    const hi = createSubgraph(peakingBand, ctx.sampleRate);
    return {
      process: () => {
        forSample((i) => {
          const x = input.ch(0).at(i);
          const y1 = low.process(x, num(1), num(0), num(0), num(0), num(0));
          const y2 = mid.process(y1, num(1), num(0), num(0), num(0), num(0));
          const y3 = hi.process(y2, num(1), num(0), num(0), num(0), num(0));
          out.ch(0).at(i).write(y3);
        });
      },
    };
  });
  const x = new Float32Array(256);
  for (let k = 0; k < 256; k++) x[k] = Math.sin((2 * Math.PI * 440 * k) / 48000);
  const r = await renderOffline(eq, {
    sampleRate: 48000,
    duration: 256 / 48000,
    inputs: { main: [x] },
  });
  for (let k = 0; k < 256; k++) {
    expect(Number.isFinite(r.outputs.main![0]![k])).toBe(true);
    expect(r.outputs.main![0]![k]).toBeCloseTo(x[k]!, 4); // passthrough
  }
});

// ── Ex 6: MIDI arpeggiator (validates MIDI in→out + event + message, §12 Ex 6) ─

const PATTERN_LEN = 4;

const arpeggiator = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const noteIn = midiInput({ name: "noteIn" });
  const arpOut = midiOutput({ name: "arpOut" });
  const pattern: State<"i32">[] = [];
  for (let s = 0; s < PATTERN_LEN; s++) pattern.push(state.i32(0).named(`step_${s}`));
  const loadPattern = message<{ steps: Float32Array }>({ name: "loadPattern" });
  const rootNote = state.i32(60).named("rootNote");
  const lastVel = state.i32(96).named("lastVel");
  const stepIdx = state.i32(0).named("stepIdx");
  const samplesPerStep = state.i32(64).named("samplesPerStep"); // small for test
  const sampleAccum = state.i32(0);
  const stepFired = event<{ step: number; note: number }>({ name: "stepFired" });
  return {
    process: () => {
      loadPattern.onReceive(({ steps }) => {
        for (let s = 0; s < PATTERN_LEN; s++) {
          pattern[s]!.store(select(lt(s, steps.length), i32(steps.at(s)), pattern[s]!.load()));
        }
      });
      noteIn.onEvent("noteOn", ({ note, velocity }) => {
        rootNote.store(note);
        lastVel.store(velocity);
      });
      forSample((i) => {
        out.ch(0).at(i).write(num(0));
        const acc = sampleAccum.load().add(1);
        const roll = acc.gt(samplesPerStep.load());
        sampleAccum.store(select(roll, num(0), acc));
        const nextStep = stepIdx.load().add(1).mod(PATTERN_LEN);
        let offset: Node<"i32"> = pattern[0]!.load();
        for (let s = 1; s < PATTERN_LEN; s++) {
          offset = select(nextStep.eq(s), pattern[s]!.load(), offset);
        }
        const fireNote = rootNote.load().add(offset);
        arpOut.emitIf(roll, {
          type: "noteOn",
          atSample: i,
          note: fireNote,
          velocity: lastVel.load(),
          channel: 0,
        });
        stepFired.emitIf(roll, { atSample: i, step: nextStep, note: fireNote });
        stepIdx.store(select(roll, nextStep, stepIdx.load()));
      });
    },
  };
});

test("Ex6 arpeggiator: latches the root note and emits the pattern on MIDI out", async () => {
  const r = await renderOffline(arpeggiator, {
    sampleRate: 48000,
    duration: 1024 / 48000, // 8 blocks; samplesPerStep=64 → ~16 steps
    events: [
      {
        name: "noteIn",
        payload: { type: "noteOn", channel: 0, note: 60, velocity: 100 },
        atSample: 0,
      },
    ],
    messages: [
      { name: "loadPattern", payload: { steps: new Float32Array([0, 4, 7, 12]) }, atQuantum: 0 },
    ],
  });
  const arp = r.events.filter((e) => e.name === "arpOut");
  const steps = r.events.filter((e) => e.name === "stepFired");
  // Steps fire over the render; each arp noteOn note = root(60) + pattern offset.
  expect(arp.length).toBeGreaterThan(0);
  expect(steps.length).toBe(arp.length);
  for (const ev of arp) {
    const p = ev.payload as { type: string; note: number; velocity: number };
    expect(p.type).toBe("noteOn");
    expect([60, 64, 67, 72]).toContain(p.note); // root + {0,4,7,12}
    expect(p.velocity).toBe(100); // latched from the inbound noteOn
  }
});

// ── Ex 8 (core): polyphonic synth voice subgraph (validates L2 + MIDI, §12 Ex 8) ─

const synthVoice = defineSubgraph((sr: number) => {
  const phase = state.f32(0);
  const env = state.f32(0);
  return {
    process: (noteHz: Node<"f32">, velocity: Node<"f32">, gate: Node<"bool">) => {
      const target = select(gate, velocity, num(0));
      const e = target.sub(env.load()).mul(0.01).add(env.load());
      env.store(e);
      const inc = noteHz.div(sr);
      const p = phase.load().add(inc);
      phase.store(select(p.gt(1), p.sub(1), p));
      return p
        .mul(2 * Math.PI)
        .sin()
        .mul(e);
    },
  };
});

test("Ex8 polysynth voice: noteOn drives a non-silent, stable signal", async () => {
  const NUM_VOICES = 4;
  const synth = defineProcessor((ctx) => {
    const out = audioOutput({ channels: 1, name: "main" });
    const keys = midiInput({ name: "keys" });
    const voiceNote: State<"i32">[] = [];
    const voiceGate: State<"bool">[] = [];
    for (let v = 0; v < NUM_VOICES; v++) {
      voiceNote.push(state.i32(69));
      voiceGate.push(state.bool(false));
    }
    const cursor = state.i32(0);
    const voices = Array.from({ length: NUM_VOICES }, () =>
      createSubgraph(synthVoice, ctx.sampleRate),
    );
    return {
      process: () => {
        keys.onEvent("noteOn", ({ note }) => {
          const c = cursor.load();
          for (let v = 0; v < NUM_VOICES; v++) {
            const isMe = c.eq(v);
            voiceNote[v]!.store(select(isMe, note, voiceNote[v]!.load()));
            voiceGate[v]!.store(select(isMe, num(true), voiceGate[v]!.load()));
          }
          cursor.store(c.add(1).mod(NUM_VOICES));
        });
        forSample((i) => {
          let mix = num(0);
          for (let v = 0; v < NUM_VOICES; v++) {
            const hz = num(440); // simplified fixed pitch for the test
            mix = mix.add(voices[v]!.process(hz, num(0.5), voiceGate[v]!.load()));
          }
          out.ch(0).at(i).write(mix);
        });
      },
    };
  });
  // No note → (near-)silence; with a note → clearly non-silent.
  const silent = await renderOffline(synth, { sampleRate: 48000, duration: 256 / 48000 });
  let silentPeak = 0;
  for (const v of silent.outputs.main![0]!) silentPeak = Math.max(silentPeak, Math.abs(v));
  expect(silentPeak).toBeLessThan(1e-3);

  const sounding = await renderOffline(synth, {
    sampleRate: 48000,
    duration: 4096 / 48000,
    events: [
      {
        name: "keys",
        payload: { type: "noteOn", channel: 0, note: 69, velocity: 100 },
        atSample: 0,
      },
    ],
  });
  let peak = 0;
  for (const v of sounding.outputs.main![0]!) {
    expect(Number.isFinite(v)).toBe(true);
    peak = Math.max(peak, Math.abs(v));
  }
  expect(peak).toBeGreaterThan(0.01); // the envelope opened, voice is sounding
});
