/**
 * Canonical examples driven end-to-end through `renderOffline`. Each test is a
 * realistic plugin asserted on behaviour (compiles, output stays stable, expected
 * events / state), exercising the combined surface rather than one primitive in
 * isolation — so a change that type-checks but breaks a real processor fails here.
 *
 * These examples live in this file, not in prose. A markdown set of them used to
 * be the integrity anchor, which meant the anchor could silently disagree with
 * the code; a runnable set cannot. The other half of that coverage is
 * `examples/demo`, which renders the same shapes through the real plugin
 * pipeline.
 */

import "@unworklet/core";
import {
  add,
  audioInput,
  audioOutput,
  instantiate,
  defineSubgraph,
  defineProcessor,
  div,
  encodeSnapshot,
  event,
  f32,
  forSample,
  i32,
  inspectSnapshot,
  lt,
  param,
  select,
  state,
  sub,
  type Node,
  type State,
} from "@unworklet/core";
import { mulVec, splat, sumLanes } from "@unworklet/core/simd";
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
            .write(rate / 1000);
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
  const y = b0.mul(x).add(z1.read());
  const z1n = b1.mul(x).add(z2.read()).sub(a1.mul(y));
  const z2n = b2.mul(x).sub(a2.mul(y));
  z1.write(z1n);
  z2.write(z2n);
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
    const low = instantiate(peakingBand, ctx.sampleRate);
    const mid = instantiate(peakingBand, ctx.sampleRate);
    const hi = instantiate(peakingBand, ctx.sampleRate);
    return {
      process: () => {
        forSample((i) => {
          const x = input.ch(0).at(i);
          const y1 = low.process(x, f32(1), f32(0), f32(0), f32(0), f32(0));
          const y2 = mid.process(y1, f32(1), f32(0), f32(0), f32(0), f32(0));
          const y3 = hi.process(y2, f32(1), f32(0), f32(0), f32(0), f32(0));
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
  const noteIn = event.midi({ from: "main", name: "noteIn" });
  const arpOut = event.midi({ to: "main", name: "arpOut" });
  const pattern: State<"i32">[] = [];
  for (let s = 0; s < PATTERN_LEN; s++) pattern.push(state.i32(0).named(`step_${s}`));
  const loadPattern = event<{ steps: Float32Array }>({ from: "main", name: "loadPattern" });
  const rootNote = state.i32(60).named("rootNote");
  const lastVel = state.i32(96).named("lastVel");
  const stepIdx = state.i32(0).named("stepIdx");
  const samplesPerStep = state.i32(64).named("samplesPerStep"); // small for test
  const sampleAccum = state.i32(0);
  const stepFired = event<{ step: number; note: number }>({ to: "main", name: "stepFired" });
  return {
    process: () => {
      loadPattern.onReceive(({ steps }) => {
        for (let s = 0; s < PATTERN_LEN; s++) {
          pattern[s]!.write(select(lt(s, steps.length), i32(steps.at(s)), pattern[s]!.read()));
        }
      });
      noteIn.onEvent("noteOn", ({ note, velocity }) => {
        rootNote.write(note);
        lastVel.write(velocity);
      });
      forSample((i) => {
        out.ch(0).at(i).write(0);
        const acc = sampleAccum.read().add(1);
        const roll = acc.gt(samplesPerStep.read());
        sampleAccum.write(select(roll, 0, acc));
        const nextStep = stepIdx.read().add(1).mod(PATTERN_LEN);
        let offset: Node<"i32"> = pattern[0]!.read();
        for (let s = 1; s < PATTERN_LEN; s++) {
          offset = select(nextStep.eq(s), pattern[s]!.read(), offset);
        }
        const fireNote = rootNote.read().add(offset);
        arpOut.emitIf(roll, {
          type: "noteOn",
          atSample: i,
          note: fireNote,
          velocity: lastVel.read(),
          channel: 0,
        });
        stepFired.emitIf(roll, { atSample: i, step: nextStep, note: fireNote });
        stepIdx.write(select(roll, nextStep, stepIdx.read()));
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
      const target = select(gate, velocity, 0);
      const e = target.sub(env.read()).mul(0.01).add(env.read());
      env.write(e);
      const inc = noteHz.div(sr);
      const p = phase.read().add(inc);
      phase.write(select(p.gt(1), p.sub(1), p));
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
    const keys = event.midi({ from: "main", name: "keys" });
    const voiceNote: State<"i32">[] = [];
    const voiceGate: State<"bool">[] = [];
    for (let v = 0; v < NUM_VOICES; v++) {
      voiceNote.push(state.i32(69));
      voiceGate.push(state.bool(false));
    }
    const cursor = state.i32(0);
    const voices = Array.from({ length: NUM_VOICES }, () =>
      instantiate(synthVoice, ctx.sampleRate),
    );
    return {
      process: () => {
        keys.onEvent("noteOn", ({ note }) => {
          const c = cursor.read();
          for (let v = 0; v < NUM_VOICES; v++) {
            const isMe = c.eq(v);
            voiceNote[v]!.write(select(isMe, note, voiceNote[v]!.read()));
            voiceGate[v]!.write(select(isMe, true, voiceGate[v]!.read()));
          }
          cursor.write(c.add(1).mod(NUM_VOICES));
        });
        forSample((i) => {
          let mix: Node<"f32"> | number = 0;
          for (let v = 0; v < NUM_VOICES; v++) {
            const hz = f32(440); // simplified fixed pitch for the test
            mix = add(mix, voices[v]!.process(hz, f32(0.5), voiceGate[v]!.read()));
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

// ── Ex 4 (core): lookahead limiter with overshoot event (§12 Ex 4) ───────────

test("Ex4 limiter: delay line + envelope + overshoot event fire on ceiling cross", async () => {
  const LOOKAHEAD = 32; // small for the test
  const limiter = defineProcessor((ctx) => {
    const input = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const ceiling = param
      .f32({ default: 0.5, min: 0, max: 1, automationRate: "k-rate" })
      .named("ceiling");
    const dly = state.buffer.f32({ size: LOOKAHEAD });
    const dlyHead = state.i32(0);
    const env = state.f32(0);
    const overshoot = event<{ level: number }>({ to: "main", name: "overshoot" });
    return {
      process: () => {
        // release coefficient uses ctx.sampleRate (= the rate-fix path).
        const relCoef = sub(1, div(-1, 0.05 * ctx.sampleRate).exp());
        const headBlock = dlyHead.read();
        forSample((i) => {
          const x = input.ch(0).at(i);
          const peak = x.abs();
          // one-pole envelope follower (state feedback).
          env.write(peak.sub(env.read()).mul(relCoef).add(env.read()));
          const wIdx = headBlock.add(i).mod(LOOKAHEAD);
          dly.write(wIdx, x);
          out
            .ch(0)
            .at(i)
            .write(dly.read(wIdx.add(1).mod(LOOKAHEAD)));
          // fire when the true peak exceeds the ceiling.
          overshoot.emitIf(peak.gt(ceiling.at(0)), { atSample: i, level: peak });
        });
        dlyHead.write(headBlock.add(128).mod(LOOKAHEAD));
      },
    };
  });
  // Input below ceiling → no overshoot; a loud sample → overshoot fires.
  const quiet = new Float32Array(128).fill(0.2);
  const noOvershoot = await renderOffline(limiter, {
    sampleRate: 48000,
    duration: 128 / 48000,
    inputs: { main: [quiet] },
    params: { ceiling: [0.5] },
  });
  expect(noOvershoot.events.filter((e) => e.name === "overshoot")).toHaveLength(0);

  const loud = new Float32Array(128).fill(0.2);
  loud[10] = 0.9; // exceeds ceiling 0.5
  loud[20] = 0.8;
  const withOvershoot = await renderOffline(limiter, {
    sampleRate: 48000,
    duration: 128 / 48000,
    inputs: { main: [loud] },
    params: { ceiling: [0.5] },
  });
  const events = withOvershoot.events.filter((e) => e.name === "overshoot");
  expect(events).toHaveLength(2);
  expect(events.map((e) => e.atSample)).toEqual([10, 20]);
  expect((events[0]!.payload as { level: number }).level).toBeCloseTo(0.9, 5);
  // output stable (no NaN).
  for (const v of withOvershoot.outputs.main![0]!) expect(Number.isFinite(v)).toBe(true);
});

// ── Ex 7 (core): SIMD convolution + persistent IR snapshot + migration (§12 Ex 7) ─

const IR_LEN = 16; // small for the test (FIR_LEN/4 = 4 SIMD iterations)

function makeReverb(withMigrationTo?: string) {
  return defineProcessor(
    () => {
      const input = audioInput({ channels: 1, name: "main" });
      const out = audioOutput({ channels: 1, name: "main" });
      const ir = state.buffer.f32({ size: IR_LEN }).expose({ name: "ir", snapshot: "persistent" });
      const hist = state.buffer.f32({ size: IR_LEN });
      const histHead = state.i32(0);
      const uploadIR = event<{ ir: Float32Array }>({ from: "main", name: "uploadIR" });
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
            let acc = splat(0);
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
    withMigrationTo === undefined
      ? undefined
      : {
          migrations: [
            {
              from: "MONOIRHASH00000",
              to: withMigrationTo,
              migrate: (blob, h) => {
                // mono-IR schema stored a single `irMono` buffer → copy into `ir`.
                const mono = h.parseBuffer(blob, "irMono", "f32");
                if (mono) h.writeBuffer("ir", "f32", mono);
              },
            },
          ],
        },
  );
}

test("Ex7 convolution reverb: SIMD path runs + IR persists through snapshot", async () => {
  const reverb = makeReverb();
  const ir = new Float32Array(IR_LEN);
  ir[0] = 1; // identity impulse → convolution ≈ delayed passthrough
  const x = new Float32Array(128);
  for (let k = 0; k < 128; k++) x[k] = Math.sin((2 * Math.PI * 200 * k) / 48000);
  const r = await renderOffline(reverb, {
    sampleRate: 48000,
    duration: 128 / 48000,
    inputs: { main: [x] },
    messages: [{ name: "uploadIR", payload: { ir }, atQuantum: 0 }],
  });
  for (const v of r.outputs.main![0]!) expect(Number.isFinite(v)).toBe(true);
  // The IR buffer is captured persistently.
  expect(inspectSnapshot(r.state).slots.ir!.kind).toBe("buffer");
  expect((inspectSnapshot(r.state).slots.ir as { length: number }).length).toBe(IR_LEN);
});

test("Ex7 reverb: restoring a mono-IR blob migrates it into the stereo `ir` buffer", async () => {
  const currentHash = makeReverb().schemaHash;
  const reverb = makeReverb(currentHash);
  // An old mono-IR blob: a single `irMono` buffer the migration renames to `ir`.
  const monoIr = new Float32Array(IR_LEN);
  monoIr[0] = 0.5;
  const oldBlob = encodeSnapshot("MONOIRHASH00000", null, [
    { name: "irMono", kind: "buffer", type: "f32", data: new Uint8Array(monoIr.buffer) },
  ]);
  const x = new Float32Array(128).fill(0.3); // steady input → convolution non-zero
  const restored = await renderOffline(reverb, {
    sampleRate: 48000,
    duration: 128 / 48000,
    inputs: { main: [x] },
    restore: oldBlob,
  });
  // Without restore the `ir` buffer is all-zero → silent; the migration loaded
  // the mono IR into `ir`, so the convolution now produces signal.
  const baseline = await renderOffline(reverb, {
    sampleRate: 48000,
    duration: 128 / 48000,
    inputs: { main: [x] },
  });
  let basePeak = 0;
  let restoredPeak = 0;
  for (const v of baseline.outputs.main![0]!) basePeak = Math.max(basePeak, Math.abs(v));
  for (const v of restored.outputs.main![0]!) restoredPeak = Math.max(restoredPeak, Math.abs(v));
  expect(basePeak).toBe(0); // no IR uploaded / restored → silent
  expect(restoredPeak).toBeGreaterThan(0); // migration loaded the IR → convolving
});
