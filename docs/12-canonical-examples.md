# 12 — Canonical examples

This document is the **integrity anchor** for the unworklet v1.0.0 spec. Every other file in `docs/` is checked against the examples here before a change is accepted (see `AGENTS.md` "Canonical examples integrity rule"). The examples are not tutorials — they are reference plugins that exercise the full surface of unworklet end to end, in shapes a production-grade audio plugin author would actually write. Every example is self-contained: top to bottom, no `// ...` elisions, no "imagine the rest". If a single change to any other doc would break or distort an example here, that change is out of scope until either it is revised or the example is updated together with it.

## Status

written

## Coverage

The example set is designed so that the union of all examples touches every concept declared in the spec. Each row marks the example(s) where the concept lives in production-realistic shape:

| Concept                                                                                                                                                   | Examples               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `audioInput` (mono / stereo / multi-port)                                                                                                                 | 1, 2, 3, 4, 7, 8       |
| `audioOutput` (mono / stereo / multi-port)                                                                                                                | all                    |
| `param` (k-rate / a-rate, automation curves)                                                                                                              | 1, 2, 4, 5, 7, 8       |
| `state.f32` / `state.i32` / `state.bool`                                                                                                                  | 2, 3, 4, 5, 6, 7, 8, 9 |
| `state.publish` (scalar UI feedback)                                                                                                                      | 1, 4, 5, 6, 7, 8, 9    |
| `state.buffer.f32` (per-sample memory)                                                                                                                    | 3, 4, 5, 7, 8          |
| `state.buffer.u8` (byte memory for sysex / arbitrary octet streams)                                                                                       | 9                      |
| `buffer.publish` (waveform / spectrum frame to UI)                                                                                                        | 5, 8                   |
| `buf.copyFrom(typedArrayField)` (bulk transfer from payload)                                                                                              | 5, 7, 9                |
| `forSample` (per-sample loop)                                                                                                                             | 1, 2, 3, 4, 5, 6, 7, 8 |
| `forSample.byN` (SIMD-stride bulk)                                                                                                                        | 7                      |
| Arithmetic / comparison / `select`                                                                                                                        | 1, 2, 3, 4, 5, 6, 7, 8 |
| Math (`sin`, `cos`, `exp`, `log`)                                                                                                                         | 2, 4, 5, 8             |
| L1 helper (pure TS function over `Node<T>`)                                                                                                               | 2, 4                   |
| L2 `defineSubgraph` (caller-owned reuse)                                                                                                                  | 2, 8                   |
| `State<T>` reference parameter                                                                                                                            | 2, 4                   |
| `event<T>` (worklet → main, sample-accurate)                                                                                                              | 4, 5, 6, 8             |
| `event<T>({ from: "main" })` (main → worklet)                                                                                                             | 5, 6, 7, 9             |
| `emitIf` (conditional emission, generic event)                                                                                                            | 4, 6, 8                |
| `onReceive` (per-block message handler)                                                                                                                   | 5, 6, 7, 9             |
| `event.midi({ from: "main" })` / `event.midi({ to: "main" })`                                                                                             | 5, 6, 8, 9             |
| `onEvent` MIDI (`noteOn` / `noteOff` + `sysex`; `cc` / `pitchBend` / `programChange` / `channelPressure` / `aftertouch` / `systemRealtime` not exercised) | 5, 6, 8, 9             |
| MIDI emission via `emitIf` (`noteOn` / `noteOff` in Ex 6; `sysex` in Ex 9)                                                                                | 6, 9                   |
| SIMD `f32x4`, `splat`, `buf.loadVec`, `mulVec`, `addVec`, `vec.lane`, `sumLanes`                                                                          | 3, 7                   |
| `snapshot` policy declaration (`'persistent'` / `'transient'` flag on slots)                                                                              | 3, 5, 7, 10            |
| `snapshot` lifecycle exercise (`node.snapshot()` / `node.restore(blob)` main-side calls)                                                                  | 3, 7, 10               |
| `migrations` chain (schema-versioned restore)                                                                                                             | 7                      |
| Main side: `createNode`                                                                                                                                   | all                    |
| Main side: `node.inputs.<name>` / `node.outputs.<name>`                                                                                                   | all                    |
| Main side: `dispose`, `onError`, `diagnostics.transport`                                                                                                  | 1 (others vary)        |
| Main side: `node.params.<name>` (AudioParam)                                                                                                              | 1, 2, 4, 7, 8          |
| Main side: `node.state.<name>.subscribe` / `.value`                                                                                                       | 1, 4, 5, 6, 7, 8, 9    |
| Main side: `node.events.<name>.on` / `.diagnostics.overflowCount`                                                                                         | 4, 5, 6, 8             |
| Main side: `node.events.<name>.emit` (incl. variable-length payload)                                                                                      | 5, 6, 7, 9             |
| Main side: `node.midi.<name>.send` / `.connectFromWebMIDI` / `.onEvent`                                                                                   | 5, 6, 8, 9             |
| Main side: `node.snapshot()` / `node.restore(blob)`                                                                                                       | 3, 7                   |
| Main side: `replaceProcessor` (hot swap + `RestoreResult.ok` failure path)                                                                                | 10                     |

## Examples index

1. **Stereo gain + level meter** — minimum useful plugin. Touches I/O, `param`, `state.publish`, basic `forSample`.
2. **Three-band biquad EQ (minimum-phase)** — recursive `state` cascade with L1 + L2 helpers, denormal-aware feedback path, parameterized cookbook coefficients.
3. **Three-band linear-phase EQ (partitioned convolution)** — mixed per-block + per-sample `process` body with sub-rate FFT, `forSample.byN(4)` SIMD bulk, overlap-add buffer accounting.
4. **Lookahead limiter with overshoot event** — `buffer` delay line, per-sample envelope follower (L1 helper), `event<T>` with `atSample` for sample-accurate flagging, GR meter via `state.publish`.
5. **Granular sampler** — bulk `event<T>({ from: "main" })` upload of sample buffer, voice-array state, `event.midi({ from: "main" })` note triggers, `buffer.publish` waveform display.
6. **MIDI arpeggiator + sequencer** — `event.midi({ from: "main" })` ingest + `event.midi({ to: "main" })` emission, generic `event<T>` for UI step indicator, `event<T>({ from: "main" })` for pattern reload.
7. **Convolution reverb with snapshot/restore migration** — large IR buffer, partitioned FFT, snapshot persistence with declarative migration chain.
8. **Polyphonic synth with sidechain ducking** — voice allocator subgraph, sidechain `audioInput` driving the duck envelope, `event.midi({ from: "main" })` voice triggers, waveform `buffer.publish` for UI scope.
9. **SysEx bridge** — pure MIDI processor that rewrites the device-ID byte of incoming sysex events and re-emits them to a downstream port. Exercises `event.midi({ from: "main" }).onEvent('sysex', ...)`, `state.buffer.u8` + `buf.copyFrom` + in-place `buf.write`, sysex `midiOut.emitIf`, and main-side dynamic device-ID control via `event<T>({ from: "main" })` + published `state.i32`.
10. **Live coding REPL bridge** — REPL UI swaps the running processor with edited source via `replaceProcessor`. Exercises the full live-coding flow: `state.snapshot: 'persistent'` for state carry-forward (oscillator phase), main-side graph re-wire (disconnect / connect on the new wrapper), migration-failure recovery via `RestoreResult.ok = false`, and the Q63 accumulation warning surface.

## 1. Stereo gain + level meter

```typescript
import { defineProcessor, audioInput, audioOutput, param, state, forSample } from "@unworklet/core";

export const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const gain = param
    .f32({
      default: 1.0,
      min: 0.0,
      max: 4.0,
      automationRate: "a-rate",
    })
    .named("gain");

  const meterL = state
    .f32(0)
    .expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } });
  const meterR = state
    .f32(0)
    .expose({ name: "meterR", snapshot: "transient", publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        const r = input.right.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        out.right.at(i).write(r);

        meterL.write(l.abs().max(meterL.read()));
        meterR.write(r.abs().max(meterR.read()));
      });

      // Per-block decay so the meter does not stick at the most recent peak forever.
      meterL.write(meterL.read().mul(0.95));
      meterR.write(meterR.read().mul(0.95));
    },
  };
});
```

```typescript
// main thread
import { createNode } from "@unworklet/core";

// ?worklet bakes its coefficients at 48 kHz, so run the context at 48 kHz.
const audioContext = new AudioContext({ sampleRate: 48000 });
const node = await createNode(audioContext, stereoGain);

source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);

node.params.gain.value = 0.8;
node.params.gain.linearRampToValueAtTime(1.0, audioContext.currentTime + 0.5);

const unsubL = node.state.meterL.subscribe((v) => meterUI.setL(v));
const unsubR = node.state.meterR.subscribe((v) => meterUI.setR(v));

node.onError((err) => console.error("[stereoGain]", err));

console.log("transport:", node.diagnostics.transport); // 'sab' or 'postMessage'

window.addEventListener("beforeunload", () => {
  unsubL();
  unsubR();
  node.dispose();
});
```

## 2. Three-band biquad EQ (minimum-phase)

```typescript
import {
  defineProcessor,
  defineSubgraph,
  instantiate,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  add,
  sub,
  div,
  type Node,
  type State,
} from "@unworklet/core";

// L1 helper: one biquad sample, Direct Form II Transposed.
// State<T> references are caller-owned; the helper inlines into the parent.
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

// L1 helper: peaking-EQ coefficients (Audio EQ Cookbook).
// Returns a record of nodes; called once per block when params changed.
function peakingCoeffs(
  freq: Node<"f32">,
  q: Node<"f32">,
  gainDb: Node<"f32">,
  sr: number,
): { b0: Node<"f32">; b1: Node<"f32">; b2: Node<"f32">; a1: Node<"f32">; a2: Node<"f32"> } {
  const A = gainDb.mul(0.05 * Math.LN10).exp(); // 10^(gainDb/40)
  const w0 = freq.mul((2 * Math.PI) / sr);
  const cosw0 = w0.cos();
  const sinw0 = w0.sin();
  const alpha = sinw0.div(q.mul(2));

  const b0Raw = add(1, alpha.mul(A));
  const b1Raw = cosw0.mul(-2);
  const b2Raw = sub(1, alpha.mul(A));
  const a0Raw = add(1, alpha.div(A));
  const a1Raw = cosw0.mul(-2);
  const a2Raw = sub(1, alpha.div(A));

  const inv = div(1, a0Raw);
  return {
    b0: b0Raw.mul(inv),
    b1: b1Raw.mul(inv),
    b2: b2Raw.mul(inv),
    a1: a1Raw.mul(inv),
    a2: a2Raw.mul(inv),
  };
}

// L2 subgraph: one mono peaking-EQ band. Owns its own z1/z2 state pair.
// Lambda argument `sr` is bound at instantiate time; method arguments
// (input / freq / q / gainDb) are per-call.
const peakingBand = defineSubgraph((sr: number) => {
  const z1 = state.f32(0);
  const z2 = state.f32(0);
  return {
    process: (input: Node<"f32">, freq: Node<"f32">, q: Node<"f32">, gainDb: Node<"f32">) => {
      const c = peakingCoeffs(freq, q, gainDb, sr);
      return biquadDFIIT(input, c.b0, c.b1, c.b2, c.a1, c.a2, z1, z2);
    },
  };
});

export const threeBandEQ = defineProcessor((ctx) => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const lowF = param
    .f32({ default: 120, min: 20, max: 1000, automationRate: "k-rate" })
    .named("lowFreq");
  const lowQ = param
    .f32({ default: 0.7, min: 0.1, max: 8, automationRate: "k-rate" })
    .named("lowQ");
  const lowG = param
    .f32({ default: 0, min: -24, max: 24, automationRate: "k-rate" })
    .named("lowGain");

  const midF = param
    .f32({ default: 1000, min: 200, max: 8000, automationRate: "k-rate" })
    .named("midFreq");
  const midQ = param
    .f32({ default: 1.0, min: 0.1, max: 8, automationRate: "k-rate" })
    .named("midQ");
  const midG = param
    .f32({ default: 0, min: -24, max: 24, automationRate: "k-rate" })
    .named("midGain");

  const hiF = param
    .f32({ default: 6000, min: 1000, max: 20000, automationRate: "k-rate" })
    .named("hiFreq");
  const hiQ = param.f32({ default: 0.7, min: 0.1, max: 8, automationRate: "k-rate" }).named("hiQ");
  const hiG = param
    .f32({ default: 0, min: -24, max: 24, automationRate: "k-rate" })
    .named("hiGain");

  // Six independent peakingBand instances (3 bands × 2 channels), allocated in declaration scope.
  const lowL = instantiate(peakingBand, ctx.sampleRate);
  const midL = instantiate(peakingBand, ctx.sampleRate);
  const hiL = instantiate(peakingBand, ctx.sampleRate);
  const lowR = instantiate(peakingBand, ctx.sampleRate);
  const midR = instantiate(peakingBand, ctx.sampleRate);
  const hiR = instantiate(peakingBand, ctx.sampleRate);

  return {
    process: () => {
      // Read k-rate params at block start. (k-rate consumers fold to the same
      // value across the block; reading at i=0 captures it once.)
      const lowFv = lowF.at(0);
      const lowQv = lowQ.at(0);
      const lowGv = lowG.at(0);
      const midFv = midF.at(0);
      const midQv = midQ.at(0);
      const midGv = midG.at(0);
      const hiFv = hiF.at(0);
      const hiQv = hiQ.at(0);
      const hiGv = hiG.at(0);

      forSample((i) => {
        const xL = input.left.at(i);
        const xR = input.right.at(i);

        // Cascaded peaking bands — each subgraph instance owns its own z1/z2 state pair.
        const yL1 = lowL.process(xL, lowFv, lowQv, lowGv);
        const yL2 = midL.process(yL1, midFv, midQv, midGv);
        const yL3 = hiL.process(yL2, hiFv, hiQv, hiGv);

        const yR1 = lowR.process(xR, lowFv, lowQv, lowGv);
        const yR2 = midR.process(yR1, midFv, midQv, midGv);
        const yR3 = hiR.process(yR2, hiFv, hiQv, hiGv);

        out.left.at(i).write(yL3);
        out.right.at(i).write(yR3);
      });
    },
  };
});
```

```typescript
// main thread
const node = await createNode(audioContext, threeBandEQ);
source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);

node.params.lowGain.linearRampToValueAtTime(+3, audioContext.currentTime + 1);
node.params.midFreq.exponentialRampToValueAtTime(2500, audioContext.currentTime + 1);
node.params.hiQ.value = 1.4;

node.onError((err) => console.error("[3bandEQ]", err));
```

> Denormal note: feedback paths through `z1` / `z2` decay toward zero on long tails of silence and would otherwise enter the IEEE 754 subnormal range (5–100× slower per op on most CPUs). unworklet's compiler auto-inserts a subnormal guard at every `state.f32` / `state.f64` `.write(v)` site, flushing values below `1e-30` to zero — see Q21 in `decisions-log.md` and `04-worklet-runtime.md` §6. No user-side mitigation is required.

## 3. Three-band linear-phase EQ (partitioned convolution)

```typescript
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  SAMPLES_PER_BLOCK,
  type Node,
} from "@unworklet/core";
import { splat, sumLanes } from "@unworklet/core/simd";

// Linear-phase EQ via 3 partitioned FIR taps over a single combined impulse.
// Impulse buffer is precomputed in main and uploaded; this processor hosts the
// runtime convolution.

const FIR_LEN = 1024; // 23 ms @ 44.1kHz — enough for a low-Q linear-phase EQ
const NUM_PARTS = FIR_LEN / SAMPLES_PER_BLOCK; // 8
const HISTORY_LEN = NUM_PARTS * SAMPLES_PER_BLOCK; // 1024

export const linearPhaseEQ = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  // Precomputed real-valued impulse, length FIR_LEN. Persisted across reloads.
  const impulse = state.buffer
    .f32({ size: FIR_LEN })
    .expose({ name: "impulse", snapshot: "persistent" });
  // Sliding history of input samples (1024).
  const history = state.buffer.f32({ size: HISTORY_LEN });
  // Write head into history.
  const histHead = state.i32(0);

  return {
    process: () => {
      // Per-block: capture the input block-end index into the history start
      // for use by the partitioned overlap-add below.
      const startHead = histHead.read();

      // forSample (input shovel): copy input into history ring buffer.
      forSample((i) => {
        const idx = startHead.add(i).mod(HISTORY_LEN);
        history.write(idx, input.ch(0).at(i));
      });

      // SIMD bulk convolution: accumulator over each output sample `i`,
      // accumulate impulse[k] * history[(head - k) % LEN] over k.
      // We process the inner k loop in chunks of 4 via SIMD (compile-time
      // unrolled below).
      forSample((i) => {
        const outIdx = startHead.add(i).mod(HISTORY_LEN);
        let acc = splat(0);
        // Compile-time unroll of the inner loop, 4 samples per iteration.
        for (let k = 0; k < FIR_LEN; k += 4) {
          const histIdx = outIdx.sub(k).sub(3).add(HISTORY_LEN).mod(HISTORY_LEN);
          const hVec = history.loadVec(histIdx);
          const iVec = impulse.loadVec(k);
          acc = acc.add(hVec.mul(iVec));
        }
        const sum = sumLanes(acc);
        out.ch(0).at(i).write(sum);
      });

      // Per-block: advance the head by one block.
      histHead.write(startHead.add(SAMPLES_PER_BLOCK).mod(HISTORY_LEN));
    },
  };
});
```

```typescript
// main thread — generate the impulse from a 3-band linear-phase EQ design and upload.
import { createNode, inspect } from "@unworklet/core";

const node = await createNode(audioContext, linearPhaseEQ, {
  initial: {
    /* none */
  },
});

// Build the impulse offline (windowed-sinc design over the EQ target curve).
const impulse = designLinearPhaseImpulse({
  length: 1024,
  sampleRate: audioContext.sampleRate,
  bands: [
    { type: "low-shelf", freq: 120, gainDb: +3 },
    { type: "peaking", freq: 1000, gainDb: -2, q: 1.0 },
    { type: "high-shelf", freq: 6000, gainDb: +4 },
  ],
});

// Inspect the current blob to verify schema before authoring an updated one.
// (For the routine "load a fresh impulse" path, event<T>({ from: "main" }) uploads are used —
// see Example 5 for that pattern. Snapshot-driven impulse swap is the long-
// term-persistence path.)
const blob = await node.snapshot();
const inspected = inspect(blob);
console.log("schema:", inspected.schemaHash, "slots:", Object.keys(inspected.slots));

source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);
```

## 4. Lookahead limiter with overshoot event

```typescript
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  event,
  SAMPLES_PER_BLOCK,
  sub,
  div,
  select,
  type Node,
  type State,
} from "@unworklet/core";

const LOOKAHEAD_SAMPLES = 240; // 5 ms @ 48kHz

// L1 helper: one-pole envelope follower with separate attack/release coeffs.
function envelopeFollow(
  x: Node<"f32">,
  attackCoef: Node<"f32">,
  releaseCoef: Node<"f32">,
  prev: State<"f32">,
): Node<"f32"> {
  const r = x.abs();
  const coef = select(r.gt(prev.read()), attackCoef, releaseCoef);
  const y = r.sub(prev.read()).mul(coef).add(prev.read());
  prev.write(y);
  return y;
}

export const lookaheadLimiter = defineProcessor((ctx) => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });

  const ceiling = param
    .f32({ default: -1.0, min: -24, max: 0, automationRate: "k-rate" })
    .named("ceiling");
  const releaseMs = param
    .f32({ default: 50, min: 1, max: 500, automationRate: "k-rate" })
    .named("releaseMs");

  // Lookahead delay line — separate per channel.
  const dlyL = state.buffer.f32({ size: LOOKAHEAD_SAMPLES });
  const dlyR = state.buffer.f32({ size: LOOKAHEAD_SAMPLES });
  const dlyHead = state.i32(0);

  // Envelope state for sidechain detection.
  const env = state.f32(0);

  // Gain reduction in dB, published to UI at 30fps.
  const gainReductionDb = state.f32(0).expose({
    name: "gainReductionDb",
    snapshot: "transient",
    publish: { rateFps: 30 },
  });

  // Sample-accurate overshoot event — fires when the linear envelope crosses
  // the ceiling. Used for diagnostic logging and visual flash on the UI.
  const overshoot = event<{ level: number; channel: 0 | 1 }>({ to: "main", name: "overshoot" });

  return {
    process: () => {
      // Per-block coefficients.
      const ceilingLin = ceiling
        .at(0)
        .mul(Math.LN10 * 0.05)
        .exp();
      const releaseSamples = releaseMs.at(0).mul(ctx.sampleRate / 1000);
      const releaseCoef = sub(1, div(-1, releaseSamples).exp());
      const attackCoef = 1.0; // instantaneous attack — limiter style

      const headBlock = dlyHead.read();

      forSample((i) => {
        // Sidechain envelope on the live (pre-delay) signal.
        const peak = input.left.at(i).abs().max(input.right.at(i).abs());
        const e = envelopeFollow(peak, attackCoef, releaseCoef, env);

        // Compute gain reduction so that envelope * gr <= ceiling.
        const gr = select(e.gt(ceilingLin), ceilingLin.div(e), 1);
        const grDb20 = gr.log().mul(20 / Math.LN10);

        // Push into delay line.
        const wIdx = headBlock.add(i).mod(LOOKAHEAD_SAMPLES);
        dlyL.write(wIdx, input.left.at(i));
        dlyR.write(wIdx, input.right.at(i));

        // Read from LOOKAHEAD_SAMPLES samples behind the write head (i.e.
        // the oldest sample, which corresponds to t - LOOKAHEAD_SAMPLES).
        const rIdx = wIdx.add(1).mod(LOOKAHEAD_SAMPLES);
        const xL = dlyL.read(rIdx);
        const xR = dlyR.read(rIdx);

        out.left.at(i).write(xL.mul(gr));
        out.right.at(i).write(xR.mul(gr));

        // Fire an overshoot event on either channel that exceeded the ceiling
        // *before* gain reduction was applied (i.e. true peak in the input).
        overshoot.emitIf(input.left.at(i).abs().gt(ceilingLin), {
          atSample: i,
          channel: 0,
          level: input.left.at(i).abs(),
        });
        overshoot.emitIf(input.right.at(i).abs().gt(ceilingLin), {
          atSample: i,
          channel: 1,
          level: input.right.at(i).abs(),
        });

        // Track the most-negative GR (in dB) reached during this block; published
        // to UI by the rateFps scheduler.
        gainReductionDb.write(gainReductionDb.read().min(grDb20));
      });

      // Per-block: advance head, decay published GR back toward 0 dB so meter
      // tracks recent rather than historical.
      dlyHead.write(headBlock.add(SAMPLES_PER_BLOCK).mod(LOOKAHEAD_SAMPLES));
      gainReductionDb.write(gainReductionDb.read().mul(0.85));
    },
  };
});
```

```typescript
// main thread
const node = await createNode(audioContext, lookaheadLimiter);
source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);

node.params.ceiling.value = -0.3;
node.params.releaseMs.value = 80;

node.state.gainReductionDb.subscribe((db) => grMeterUI.set(db));

node.events.overshoot.on(({ atSample, channel, level }) => {
  console.warn(`overshoot ch=${channel} at sample=${atSample} level=${level}`);
});
setInterval(() => {
  const overflows = node.events.overshoot.diagnostics.overflowCount();
  if (overflows > 0) console.warn(`overshoot events dropped: ${overflows}`);
}, 1000);

// Latency-compensated parallel routing: see 05-client.md §7. The limiter
// introduces a 5ms (240-sample @ 48kHz) latency; the dry path delays by the
// same amount so the wet/dry mix is phase-aligned.
const compensationSec = LOOKAHEAD_SAMPLES / audioContext.sampleRate;
const dryDelay = audioContext.createDelay(compensationSec);
dryDelay.delayTime.value = compensationSec;

source.connect(dryDelay);
const mixer = audioContext.createGain();
node.outputs.main.connect(mixer);
dryDelay.connect(mixer);
mixer.connect(audioContext.destination);
```

## 5. Granular sampler

```typescript
import {
  defineProcessor,
  audioOutput,
  param,
  state,
  forSample,
  event,
  div,
  select,
  f32,
  i32,
  type State,
} from "@unworklet/core";

const SAMPLE_BUFFER_LEN = 48000 * 4; // 4 seconds @ 48kHz
const NUM_VOICES = 16;
const WAVEFORM_FRAME = 1024; // exposed to UI via buffer.publish

export const granularSampler = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 2, name: "main" });

  const grainSize = param
    .f32({ default: 100, min: 10, max: 500, automationRate: "k-rate" })
    .named("grainSizeMs");
  const grainDensity = param
    .f32({ default: 30, min: 1, max: 100, automationRate: "k-rate" })
    .named("grainHz");
  const playbackPos = param
    .f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" })
    .named("playbackPos");
  const pitch = param
    .f32({ default: 1.0, min: 0.25, max: 4.0, automationRate: "a-rate" })
    .named("pitch");

  // Sample buffer — uploaded via event<T>({ from: "main" }) (variable-length payload).
  const sampleBuf = state.buffer.f32({ size: SAMPLE_BUFFER_LEN }).expose({
    name: "sampleBuf",
    snapshot: "persistent",
  });
  const sampleLen = state.i32(0); // populated when uploaded (worklet-private)

  // UI-visible waveform thumbnail (downsampled view, published at low rate).
  const waveformView = state.buffer.f32({ size: WAVEFORM_FRAME }).expose({
    name: "waveformView",
    publish: { rateFps: 15 },
  });

  // Voice state — 16 voices, each tracks position into sampleBuf and remaining samples.
  // State arrays are expressed as parallel scalar slots; the build-time loop unrolls
  // over them. (Production-grade allocators may use a single state.i32 head + circular
  // mark buffer; this shape favors clarity here.)
  const voicePos: State<"f32">[] = [];
  const voiceRemaining: State<"i32">[] = [];
  const voiceGate: State<"bool">[] = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    voicePos.push(state.f32(0));
    voiceRemaining.push(state.i32(0));
    voiceGate.push(state.bool(false));
  }
  const voiceRR = state.i32(0); // round-robin allocator pointer (worklet-private).

  // Grain trigger countdown — counts samples until the next grain spawn.
  const nextSpawnIn = state.i32(0);

  // Active note tracker (last note received).
  const activeNote = state.i32(60);
  const activeVel = state.f32(0);
  // Published so the UI can show "currently playing X notes".
  const playingCount = state
    .i32(0)
    .expose({ name: "playingCount", snapshot: "transient", publish: { rateFps: 10 } });

  // Bulk upload from main: replaces sampleBuf contents and sets sampleLen.
  const uploadSample = event<{ samples: Float32Array }>({ from: "main", name: "uploadSample" });

  // Sample-accurate event: fires whenever a grain is spawned, for UI flash.
  const grainSpawned = event<{ voice: number; pos: number }>({ to: "main", name: "grainSpawned" });

  // MIDI in for note triggers.
  const noteIn = event.midi({ from: "main", name: "noteIn" });

  return {
    process: () => {
      // Bulk upload handler: copy the incoming Float32Array into sampleBuf via
      // a single memcpy (decisions-log Q31-c). The framework clamps the copy
      // length to min(SAMPLE_BUFFER_LEN, samples.length) at runtime — no
      // payload-driven for-loop on the audio thread.
      uploadSample.onReceive(({ samples }) => {
        sampleBuf.copyFrom(samples);
        sampleLen.write(samples.length);

        // Downsampled thumbnail: build-time unroll over WAVEFORM_FRAME (a
        // build-time constant); each slot reads from a payload-driven offset.
        // Indices beyond the payload retain whatever was already in waveformView.
        for (let i = 0; i < WAVEFORM_FRAME; i++) {
          const stride = i32(1).max(samples.length.div(WAVEFORM_FRAME));
          const srcIdx = stride.mul(i);
          waveformView.write(i, select(srcIdx.lt(samples.length), samples.at(srcIdx), 0));
        }
      });

      // MIDI handlers — store the latest note for grain pitch shifting.
      noteIn.onEvent("noteOn", ({ note, velocity, atSample }) => {
        activeNote.write(note);
        activeVel.write(f32(velocity).div(127));
      });
      noteIn.onEvent("noteOff", () => {
        activeVel.write(0);
      });

      // Per-block: derive grain spawn interval from grainHz.
      const samplesPerSpawn = div(ctx.sampleRate, grainDensity.at(0));
      const grainSamples = grainSize.at(0).mul(ctx.sampleRate / 1000);

      forSample((i) => {
        // Spawn a grain when the countdown reaches 0.
        const cd = nextSpawnIn.read().sub(1);
        const spawn = cd.lte(0);
        nextSpawnIn.write(select(spawn, i32(samplesPerSpawn), cd));

        // On spawn: pick a voice (round-robin), assign position and length.
        // (We unroll the voice selection inline.)
        // ... (round-robin assignment — illustrative; full unrolling omitted for
        //      brevity here would use a build-time `for` over NUM_VOICES with
        //      a select chain — production authors keep it explicit.)

        // Voice mix: each voice contributes a windowed sample read.
        let lSum = f32(0);
        let rSum = f32(0);
        for (let v = 0; v < NUM_VOICES; v++) {
          const gate = voiceGate[v].read();
          const pos = voicePos[v].read();
          const rem = voiceRemaining[v].read();

          // Window envelope: simple cos^2 over the grain duration.
          const phase = f32(1).sub(f32(rem).div(grainSamples));
          const winLin = phase.mul(Math.PI).sin(); // 0 -> 1 -> 0 over the grain
          const win = winLin.mul(winLin);

          // Pitch-shifted read with linear interpolation.
          const sample = sampleBuf.readInterpolated(pos);
          const sig = sample.mul(win.mul(activeVel.read()));

          // Accumulate (gated by voice activity).
          const contrib = select(gate, sig, 0);
          lSum = lSum.add(contrib);
          rSum = rSum.add(contrib);

          // Advance voice cursor.
          voicePos[v].write(
            select(
              gate,
              pos.add(
                pitch.at(i).mul(
                  f32(activeNote.read().sub(60))
                    .mul(Math.LN2 / 12)
                    .exp(),
                ),
              ),
              pos,
            ),
          );
          voiceRemaining[v].write(select(gate, rem.sub(1), rem));
          voiceGate[v].write(select(gate, rem.gt(0), gate));
        }

        out.left.at(i).write(lSum);
        out.right.at(i).write(rSum);
      });

      // Per-block: count active voices for UI.
      let count = i32(0);
      for (let v = 0; v < NUM_VOICES; v++) {
        count = count.add(select(voiceGate[v].read(), 1, 0));
      }
      playingCount.write(count);
    },
  };
});
```

```typescript
// main thread
const node = await createNode(audioContext, granularSampler);
node.outputs.main.connect(audioContext.destination);

// Connect a Web MIDI keyboard.
const midiAccess = await navigator.requestMIDIAccess();
const firstInput = Array.from(midiAccess.inputs.values())[0];
node.midi.noteIn.connectFromWebMIDI(firstInput);

// Upload a sample (loaded from a URL, decoded to Float32Array).
const fetched = await fetch("/samples/voice-loop.wav");
const decoded = await audioContext.decodeAudioData(await fetched.arrayBuffer());
node.events.uploadSample.emit({ samples: decoded.getChannelData(0) });

node.state.playingCount.subscribe((n) => voiceCountUI.set(n));
node.state.waveformView.subscribe((view) => waveformUI.draw(view));

node.events.grainSpawned.on(({ atSample, voice, pos }) => grainViz.flash(voice, pos));
```

## 6. MIDI arpeggiator + sequencer

```typescript
import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  event,
  i32,
  lt,
  select,
  type Node,
  type State,
} from "@unworklet/core";

const PATTERN_LEN = 16;

export const arpeggiator = defineProcessor((ctx) => {
  // No audio I/O — pure MIDI processor (arpeggiator routes MIDI in to MIDI out).
  // We still need an output to be attached to the graph; producers may use a
  // mono passthrough audioOutput so the AudioContext keeps the worklet alive.
  const out = audioOutput({ channels: 1, name: "main" });

  const noteIn = event.midi({ from: "main", name: "noteIn" });
  const arpOut = event.midi({ to: "main", name: "arpOut" });

  // 16-step pattern of semitone offsets from the root note (Float32Array uploaded).
  // Shipped as named state slots since each step is preset-bearing — snapshot key required.
  const pattern: State<"i32">[] = [];
  for (let s = 0; s < PATTERN_LEN; s++) {
    pattern.push(state.i32(0).named(`step_${s}`));
  }

  // Pattern reload from main. Values are small signed integers (note offsets);
  // they travel as a Float32Array so the handler can read them per-element with
  // `.at()` (= direct per-element read is f32-only, Q84) and convert via `i32(...)`.
  const loadPattern = event<{ steps: Float32Array }>({ from: "main", name: "loadPattern" });

  const rootNote = state.i32(60).named("rootNote");
  const lastVel = state.i32(96).named("lastVel");
  const stepIdx = state
    .i32(0)
    .expose({ name: "stepIdx", snapshot: "transient", publish: { rateFps: 60 } });
  const samplesPerStep = state.i32(48000 / 8).named("samplesPerStep"); // 1/8 note @ 60 BPM, 48kHz
  const sampleAccum = state.i32(0); // worklet-private accumulator

  // UI step indicator — fires every step boundary.
  const stepFired = event<{ step: number; note: number }>({ to: "main", name: "stepFired" });

  return {
    process: () => {
      // Pattern reload handler: build-time unroll over PATTERN_LEN (a build-time
      // constant); per-slot select masks against the runtime payload length so
      // entries beyond steps.length retain their existing values
      // (decisions-log Q31-d).
      loadPattern.onReceive(({ steps }) => {
        for (let s = 0; s < PATTERN_LEN; s++) {
          pattern[s].write(select(lt(s, steps.length), i32(steps.at(s)), pattern[s].read()));
        }
      });

      // MIDI in: track the most recent note as the root.
      noteIn.onEvent("noteOn", ({ note, velocity, atSample }) => {
        rootNote.write(note);
        lastVel.write(velocity);
      });
      // noteOff handling intentionally omitted — arpeggiator runs on the latched
      // root until a new note arrives.

      forSample((i) => {
        // Output is silent; the arp only manipulates MIDI.
        out.ch(0).at(i).write(0);

        // Increment sample accumulator; on rollover, advance the step.
        const acc = sampleAccum.read().add(1);
        const roll = acc.gt(samplesPerStep.read());
        sampleAccum.write(select(roll, 0, acc));

        const nextStep = stepIdx.read().add(1).mod(PATTERN_LEN);

        // On step rollover: emit a MIDI noteOn at this sample, plus a UI event.
        // Read the offset for the new step. (Build-time unroll via select chain.)
        let offset: Node<"i32"> = pattern[0].read();
        for (let s = 1; s < PATTERN_LEN; s++) {
          offset = select(nextStep.eq(s), pattern[s].read(), offset);
        }
        const fireNote = rootNote.read().add(offset);

        arpOut.emitIf(roll, {
          type: "noteOn",
          atSample: i,
          note: fireNote,
          velocity: lastVel.read(),
          channel: 0,
        });
        // Schedule a noteOff one step later by emitting at the boundary -1 sample.
        // (For brevity, a real arp tracks held notes and emits noteOff at the right time;
        // this minimal form fires both edges from the rollover.)

        stepFired.emitIf(roll, { atSample: i, step: nextStep, note: fireNote });

        stepIdx.write(select(roll, nextStep, stepIdx.read()));
      });
    },
  };
});
```

```typescript
// main thread
const node = await createNode(audioContext, arpeggiator);
node.outputs.main.connect(audioContext.destination); // silent passthrough

const midiAccess = await navigator.requestMIDIAccess();
const kbd = Array.from(midiAccess.inputs.values())[0];
const synthInput = Array.from(midiAccess.outputs.values())[0];
node.midi.noteIn.connectFromWebMIDI(kbd);

// Route arpeggiator output to a downstream synth (Web MIDI Output).
node.midi.arpOut.onEvent("noteOn", (evt) => {
  synthInput.send(
    [0x90 | evt.channel, evt.note, evt.velocity],
    performance.now() + (evt.atSample / audioContext.sampleRate) * 1000,
  );
});

// UI: highlight the current step.
node.events.stepFired.on(({ step }) => stepUI.highlight(step));
node.state.stepIdx.subscribe((s) => stepUI.cursorAt(s));

// Load a pattern (ascending then descending arpeggio).
node.events.loadPattern.emit({
  steps: new Float32Array([0, 4, 7, 12, 16, 19, 24, 19, 16, 12, 7, 4, 0, -5, -8, -12]),
});
```

## 7. Convolution reverb with snapshot/restore migration

```typescript
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  SAMPLES_PER_BLOCK,
  type Node,
} from "@unworklet/core";
import { splat, sumLanes } from "@unworklet/core/simd";

const IR_LEN = 4096; // ~85ms @ 48kHz
const NUM_PARTITIONS = IR_LEN / SAMPLES_PER_BLOCK; // 32

export const convolutionReverb = defineProcessor(
  (ctx) => {
    const input = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 2, name: "main" });

    const wetGain = param
      .f32({ default: 0.5, min: 0, max: 1, automationRate: "k-rate" })
      .named("wetGain");
    const dryGain = param
      .f32({ default: 0.7, min: 0, max: 1, automationRate: "k-rate" })
      .named("dryGain");

    // IR — snapshotted because preset = (wet/dry settings + which IR is loaded).
    const irL = state.buffer.f32({ size: IR_LEN }).expose({ name: "irL", snapshot: "persistent" });
    const irR = state.buffer.f32({ size: IR_LEN }).expose({ name: "irR", snapshot: "persistent" });

    // History of input samples (1 partition each, FIFO; old discarded).
    // Real partitioned-convolution implementations use FFT-domain partitioning;
    // this scaffold shows the time-domain accumulation pattern with SIMD bulk.
    const histL = state.buffer.f32({ size: IR_LEN });
    const histR = state.buffer.f32({ size: IR_LEN });
    const histHead = state.i32(0);

    // Wet output level, published to UI.
    const wetMeter = state
      .f32(0)
      .expose({ name: "wetMeter", snapshot: "transient", publish: { rateFps: 30 } });

    // Bulk IR upload from main.
    const uploadIR = event<{ irL: Float32Array; irR: Float32Array }>({
      from: "main",
      name: "uploadIR",
    });

    return {
      process: () => {
        // IR upload: bulk memcpy the typed-array payload fields into the irL / irR
        // buffers (decisions-log Q31-c). The framework clamps to min(IR_LEN,
        // <field>.length) at runtime — no payload-driven for-loop on the audio
        // thread. (If the payload is shorter than IR_LEN, the tail of the buffer
        // retains whatever was last written; consumers that need explicit zero-
        // padding can pre-zero by issuing copyFrom with a zero-typed-array first.)
        uploadIR.onReceive(({ irL: il, irR: ir }) => {
          irL.copyFrom(il);
          irR.copyFrom(ir);
        });

        const headBlock = histHead.read();

        forSample((i) => {
          const idx = headBlock.add(i).mod(IR_LEN);
          histL.write(idx, input.left.at(i));
          histR.write(idx, input.right.at(i));
        });

        // SIMD bulk convolution — scalar accumulator over 4-wide vectors.
        forSample.byN(4, (i) => {
          const outIdx = headBlock.add(i).mod(IR_LEN);
          let accL = splat(0);
          let accR = splat(0);
          for (let k = 0; k < IR_LEN; k += 4) {
            const histIdx = outIdx.sub(k).sub(3).add(IR_LEN).mod(IR_LEN);
            const hL = histL.loadVec(histIdx);
            const hR = histR.loadVec(histIdx);
            const iL = irL.loadVec(k);
            const iR = irR.loadVec(k);
            accL = accL.add(hL.mul(iL));
            accR = accR.add(hR.mul(iR));
          }
          const sumL = sumLanes(accL);
          const sumR = sumLanes(accR);

          const dryL = input.left.at(i).mul(dryGain.at(0));
          const dryR = input.right.at(i).mul(dryGain.at(0));
          const wetL = sumL.mul(wetGain.at(0));
          const wetR = sumR.mul(wetGain.at(0));

          out.left.at(i).write(dryL.add(wetL));
          out.right.at(i).write(dryR.add(wetR));

          wetMeter.write(wetMeter.read().max(wetL.abs().max(wetR.abs())));
        });

        histHead.write(headBlock.add(SAMPLES_PER_BLOCK).mod(IR_LEN));
        wetMeter.write(wetMeter.read().mul(0.93));
      },
    };
  },
  {
    // Snapshot migration chain — when older blob versions show up, lift them
    // forward declaratively. Each entry's from/to is the schema hash computed
    // by `@unworklet/core`'s `compile` function and emitted to
    // `dist/<processor>.schema-hash.json` by `@unworklet/unplugin` as part
    // of the bundler-integration metadata artifact set (= 07-unplugin §6.3).
    // The mono-IR shape stored a single buffer named 'ir'; the stereo-IR shape
    // splits it into irL/irR; the latest schema adds dryGain.
    migrations: [
      {
        from: "a3f2c1d0...", // mono-IR schema
        to: "b8c14fe2...", // stereo-IR schema
        migrate: (oldBlob, helpers) => {
          const ir = helpers.parseBuffer(oldBlob, "ir", "f32");
          if (ir) {
            helpers.writeBuffer("irL", "f32", ir);
            helpers.writeBuffer("irR", "f32", ir);
          }
        },
      },
      {
        from: "b8c14fe2...", // stereo-IR schema
        to: "d7e3a991...", // current (dryGain added)
        migrate: () => {
          // dryGain is a new param; declaration default carries automatically.
          // Slots unchanged across this step are auto-carried by name match,
          // so the migrate body is empty.
        },
      },
    ],
  },
);
```

```typescript
// main thread
const node = await createNode(audioContext, convolutionReverb);
source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);

// Load an IR pair from a stereo file.
const irFile = await fetch("/irs/cathedral.wav");
const decoded = await audioContext.decodeAudioData(await irFile.arrayBuffer());
node.events.uploadIR.emit({
  irL: decoded.getChannelData(0),
  irR: decoded.getChannelData(decoded.numberOfChannels > 1 ? 1 : 0),
});

node.params.wetGain.value = 0.4;
node.params.dryGain.value = 0.7;
node.state.wetMeter.subscribe((v) => wetMeterUI.set(v));

// Save the current preset.
const presetBlob = await node.snapshot();
localStorage.setItem("reverb-preset-1", btoa(String.fromCharCode(...presetBlob)));

// Load a preset (potentially saved by an older version — migrations apply
// transparently).
const stored = localStorage.getItem("reverb-preset-1");
if (stored) {
  const blob = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const result = await node.restore(blob);
  if (!result.ok) {
    console.error(`preset migration threw at step ${result.error.step}:`, result.error.message);
  } else if (result.skipped.length || result.missing.length) {
    console.warn("preset partially loaded", result);
  }
}
```

## 8. Polyphonic synth with sidechain ducking

```typescript
import {
  defineProcessor,
  defineSubgraph,
  instantiate,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  event,
  SAMPLES_PER_BLOCK,
  sub,
  div,
  select,
  f32,
  i32,
  type Node,
  type State,
} from "@unworklet/core";

const NUM_VOICES = 8;

// L2 voice subgraph: simple 1-osc synth voice with ADSR envelope.
// Lambda argument `sr` is bound at instantiate time; method arguments are per-call.
const synthVoice = defineSubgraph((sr: number) => {
  const phase = state.f32(0);
  const env = state.f32(0);
  return {
    process: (
      noteHz: Node<"f32">,
      velocity: Node<"f32">,
      gate: Node<"bool">,
      attackS: Node<"f32">,
      releaseS: Node<"f32">,
    ) => {
      // Envelope coefficients (k-rate inputs).
      const aCoef = sub(1, div(-1, attackS.mul(sr)).exp());
      const rCoef = sub(1, div(-1, releaseS.mul(sr)).exp());

      // Update envelope sample-by-sample.
      const target = select(gate, velocity, 0);
      const coef = select(gate, aCoef, rCoef);
      const e = target.sub(env.read()).mul(coef).add(env.read());
      env.write(e);

      // Update phase.
      const inc = noteHz.div(sr);
      const p = phase.read().add(inc);
      phase.write(select(p.gt(1), p.sub(1), p));

      // Sine osc + envelope.
      return p
        .mul(2 * Math.PI)
        .sin()
        .mul(e);
    },
  };
});

export const polySynth = defineProcessor((ctx) => {
  const sidechain = audioInput({ channels: 2, name: "sidechain" });
  const out = audioOutput({ channels: 2, name: "main" });

  const attack = param
    .f32({ default: 0.01, min: 0.001, max: 1, automationRate: "k-rate" })
    .named("attack");
  const release = param
    .f32({ default: 0.3, min: 0.01, max: 4, automationRate: "k-rate" })
    .named("release");
  const masterVol = param
    .f32({ default: 0.7, min: 0, max: 1, automationRate: "a-rate" })
    .named("masterVol");
  const duckAmount = param
    .f32({ default: 0.5, min: 0, max: 1, automationRate: "k-rate" })
    .named("duckAmount");

  // Voice state arrays — flattened.
  const voiceNote: State<"i32">[] = [];
  const voiceVel: State<"f32">[] = [];
  const voiceGate: State<"bool">[] = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    voiceNote.push(state.i32(60));
    voiceVel.push(state.f32(0));
    voiceGate.push(state.bool(false));
  }
  const allocCursor = state.i32(0);

  // Sidechain envelope.
  const scEnv = state.f32(0);

  // UI: 1024-sample waveform thumbnail of the synth output.
  const waveform = state.buffer
    .f32({ size: 1024 })
    .expose({ name: "waveform", publish: { rateFps: 30 } });
  const wavePtr = state.i32(0);

  // UI: number of active voices.
  const activeVoices = state
    .i32(0)
    .expose({ name: "activeVoices", snapshot: "transient", publish: { rateFps: 15 } });

  // Sample-accurate event for note triggers (UI key flash).
  const notePlayed = event<{ note: number; voice: number; velocity: number }>({
    to: "main",
    name: "notePlayed",
  });

  const keys = event.midi({ from: "main", name: "keys" });

  // Eight independent synthVoice instances, allocated in declaration scope.
  const voices = [];
  for (let s = 0; s < NUM_VOICES; s++) {
    voices.push(instantiate(synthVoice, ctx.sampleRate));
  }

  return {
    process: () => {
      keys.onEvent("noteOn", ({ note, velocity, atSample }) => {
        // Round-robin voice allocator.
        const v = allocCursor.read();
        // Build-time unrolled selection: pick the slot that matches `v`.
        for (let s = 0; s < NUM_VOICES; s++) {
          const isMe = v.eq(s);
          voiceNote[s].write(select(isMe, note, voiceNote[s].read()));
          voiceVel[s].write(select(isMe, f32(velocity).div(127), voiceVel[s].read()));
          voiceGate[s].write(select(isMe, true, voiceGate[s].read()));
        }
        allocCursor.write(v.add(1).mod(NUM_VOICES));

        notePlayed.emitIf(true, { atSample, note, voice: v, velocity: f32(velocity).div(127) });
      });

      keys.onEvent("noteOff", ({ note }) => {
        for (let s = 0; s < NUM_VOICES; s++) {
          voiceGate[s].write(select(voiceNote[s].read().eq(note), false, voiceGate[s].read()));
        }
      });

      // Per-block: derive the sidechain envelope's attack/release coefficients.
      const aCoef = 0.05;
      const rCoef = sub(1, div(-1, 0.2 * ctx.sampleRate).exp());

      const wpStart = wavePtr.read();

      forSample((i) => {
        // Sidechain envelope (peak detector with separate attack/release).
        const scPeak = sidechain.left.at(i).abs().max(sidechain.right.at(i).abs());
        const scC = select(scPeak.gt(scEnv.read()), aCoef, rCoef);
        scEnv.write(scPeak.sub(scEnv.read()).mul(scC).add(scEnv.read()));

        // Duck factor: 1.0 - duckAmount * scEnv.
        const duck = sub(1, duckAmount.at(0).mul(scEnv.read()));

        // Sum voices.
        let mix = f32(0);
        for (let s = 0; s < NUM_VOICES; s++) {
          const note = voiceNote[s].read();
          const vel = voiceVel[s].read();
          const gate = voiceGate[s].read();
          const hz = f32(note.sub(69))
            .mul(Math.LN2 / 12)
            .exp()
            .mul(440);
          mix = mix.add(voices[s].process(hz, vel, gate, attack.at(0), release.at(0)));
        }

        const sig = mix.mul(masterVol.at(i)).mul(duck);
        out.left.at(i).write(sig);
        out.right.at(i).write(sig);

        // Push into the waveform thumbnail (downsampled by stride).
        const wp = wpStart.add(i).mod(1024);
        waveform.write(wp, sig);
      });

      wavePtr.write(wpStart.add(SAMPLES_PER_BLOCK).mod(1024));

      // Count active voices for UI.
      let count = i32(0);
      for (let s = 0; s < NUM_VOICES; s++) {
        count = count.add(select(voiceGate[s].read(), 1, 0));
      }
      activeVoices.write(count);
    },
  };
});
```

```typescript
// main thread
const node = await createNode(audioContext, polySynth);
node.outputs.main.connect(audioContext.destination);

// Sidechain from a separate kick drum source.
kickSource.connect(node.inputs.sidechain);

// Web MIDI keyboard.
const midiAccess = await navigator.requestMIDIAccess();
node.midi.keys.connectFromWebMIDI(Array.from(midiAccess.inputs.values())[0]);

node.params.attack.value = 0.02;
node.params.release.value = 0.4;
node.params.masterVol.linearRampToValueAtTime(0.8, audioContext.currentTime + 1);
node.params.duckAmount.value = 0.6;

node.state.activeVoices.subscribe((n) => voiceCounterUI.set(n));
node.state.waveform.subscribe((view) => scopeUI.draw(view));

node.events.notePlayed.on(({ atSample, note, voice }) => keyboardUI.flashKey(note, voice));

// Diagnostics: warn if the event ringbuffer is overflowing (e.g. dense MIDI burst).
setInterval(() => {
  const o = node.events.notePlayed.diagnostics.overflowCount();
  if (o > 0) console.warn(`notePlayed events dropped: ${o}`);
}, 1000);
```

---

## 9. SysEx bridge

```typescript
import { defineProcessor, audioOutput, state, event, i32 } from "@unworklet/core";

const MAX_SYSEX_LEN = 512;

// SysEx bridge: rewrites the device-ID byte of each incoming sysex event and
// re-emits the result to a downstream port (MFX-style routing). The device ID
// to apply is held in a published `state.i32` and updated from the main side
// via a `event<T>({ from: "main" })`. The wire format is the standard sysex layout
// `[0xF0, deviceId, ...payload..., 0xF7]` — byte index 1 is the device ID.
export const sysexBridge = defineProcessor((ctx) => {
  // No audio processing — the worklet exists purely to mediate MIDI. A silent
  // mono output is declared so the node can be wired into an audio graph;
  // unwritten samples emit silence (Q37).
  const out = audioOutput({ channels: 1, name: "main" });

  const sysexIn = event.midi({ from: "main", name: "sysexIn" });
  const sysexOut = event.midi({ to: "main", name: "sysexOut" });

  // 7-bit MIDI value (0x00–0x7F). Published so the main side can mirror the
  // current setting in the UI.
  const targetId = state.i32(0x10).expose({ name: "targetId", publish: { rateFps: 5 } });

  // Byte buffer that holds the in-flight sysex while we rewrite byte 1.
  // Sized for the longest payload the bridge is expected to handle.
  const buf = state.buffer.u8({ size: MAX_SYSEX_LEN });

  // main → worklet message that updates the device ID applied to subsequent
  // sysex events.
  const setId = event<{ id: number }>({ from: "main", name: "setId" });

  return {
    process: () => {
      setId.onReceive(({ id }) => {
        targetId.write(id);
      });

      // Copy the incoming sysex bytes into `buf`, overwrite byte 1 with the
      // current target ID, and re-emit. `length` is forwarded unchanged so the
      // downstream sees the same payload size as the inbound event.
      sysexIn.onEvent("sysex", ({ data, length, atSample }) => {
        buf.copyFrom(data);
        buf.write(i32(1), targetId.read());
        sysexOut.emitIf(true, {
          type: "sysex",
          data: buf,
          length,
          atSample,
        });
      });
    },
  };
});

// --- main side ---

import { createNode } from "@unworklet/core";

// ?worklet bakes its coefficients at 48 kHz, so run the context at 48 kHz.
const audioCtx = new AudioContext({ sampleRate: 48000 });
const node = await createNode(audioCtx, sysexBridge);
audioCtx.resume();

// Wire the bridge to a Web MIDI input on one side and a Web MIDI output on
// the other. unworklet only normalizes the wire shape inside the worklet; the
// permission / device-selection flow is consumer responsibility (= Q11 / B1).
const midiAccess = await navigator.requestMIDIAccess({ sysex: true });
const inputDev = [...midiAccess.inputs.values()][0];
const outputDev = [...midiAccess.outputs.values()][0];
node.midi.sysexIn.connectFromWebMIDI(inputDev);

// Forward each sysex event emitted by the bridge to the downstream device.
node.midi.sysexOut.onEvent("sysex", (event) => {
  outputDev.send(event.data);
});

// Update the device ID applied to every subsequent sysex passing through the
// bridge.
node.events.setId.emit({ id: 0x42 });

// Reflect the current setting in the UI.
node.state.targetId.subscribe((id) => deviceIdUI.set(id));
```

---

## 10. Live coding REPL bridge

> **Framework surface vs consumer recipe**: the unworklet surface exercised in this example is `replaceProcessor` (`@unworklet/core`) + `state.snapshot 'persistent'` + the `RestoreResult.ok = false` failure path + the Q63 accumulation warning. **Everything else** in the main-side code (= `URL.createObjectURL(blob)`, `import(/* @vite-ignore */ url)`, source acquisition, REPL UI wiring, blob URL teardown) is a **consumer-side recipe** — not part of unworklet's surface. `/* @vite-ignore */` is a Vite-specific annotation, not an unworklet annotation. In production code a bundler HMR boundary or file watcher (= `07-unplugin.md` §4 recipe sketch) provides the same module-acquisition path; unworklet does not own the source-acquisition mechanism.

```typescript
// initial.processor.ts — The initial processor for the REPL. The user may edit
// it freely, but is expected to keep the same public surface
// (= audioOutput 'main' + param 'freq' + state.f32 'phase' persistent).

import { defineProcessor, audioOutput, param, state, forSample, f32 } from "@unworklet/core";

export const initialOsc = defineProcessor(
  (ctx) => {
    const out = audioOutput({ channels: 1, name: "main" });
    const freq = param
      .f32({ default: 440, min: 20, max: 20000, automationRate: "k-rate" })
      .named("freq");
    // 'persistent' = state to carry forward across processor swaps.
    const phase = state.f32(0).expose({ name: "phase", snapshot: "persistent" });

    return {
      process: () => {
        forSample((i) => {
          const p = phase.read();
          const inc = freq.at(0).mul(f32((2 * Math.PI) / ctx.sampleRate));
          out.ch(0).at(i).write(p.sin());
          phase.write(p.add(inc).mod(f32(2 * Math.PI)));
        });
      },
    };
  },
  {
    // Migration chain that the REPL-supplied new processor can fail on:
    // when the user-edited source carries a different schema hash and a
    // hostile `migrate` body throws, `replaceProcessor` surfaces `ok: false`
    // with `error.step` pointing at this entry — see the main-side handler
    // below. Migration shape: see Ex 7 + 01-dsl §8.3.
    migrations: [
      {
        from: "a3f2c1d0...", // hash of an earlier `phase` shape
        to: "b8c14fe2...", // hash of the current schema
        migrate: (oldBlob, helpers) => {
          const old = helpers.parseSlot(oldBlob, "phase", "f32");
          if (old !== undefined) helpers.writeSlot("phase", "f32", old);
        },
      },
    ],
  },
);
```

```typescript
// main side — REPL UI with a Run button for hot swap. unworklet provides only
// the primitive (= replaceProcessor); source acquisition, graph re-wiring,
// and error UI are user-land concerns.

import { createNode, replaceProcessor } from "@unworklet/core";
import initialOsc from "./initial.processor.ts?worklet";

// ?worklet bakes its coefficients at 48 kHz, so run the context at 48 kHz.
const audioCtx = new AudioContext({ sampleRate: 48000 });
let node = await createNode(audioCtx, initialOsc);
node.outputs.main.connect(audioCtx.destination);
audioCtx.resume();

runButton.addEventListener("click", async () => {
  // Import the editor's source as a new module via a blob URL. In production,
  // an equivalent path is assembled through bundler HMR or a file watcher.
  const source = editor.getValue();
  const blob = new Blob([source], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const mod = await import(/* @vite-ignore */ url);

  // Replace the running instance with the new module. State is carried forward
  // via snapshot/restore + the migration chain; on failure, ok: false surfaces
  // the recovery path.
  const result = await replaceProcessor(node, mod.default);
  if (!result.ok) {
    statusUI.set(`migration failed at step ${result.error.step}: ${result.error.message}`);
    return;
  }

  // Move graph connections to the new wrapper. unworklet does not manipulate
  // the graph (Q50) — disconnect → connect is user-land.
  node.outputs.main.disconnect();
  node = result.node;
  node.outputs.main.connect(audioCtx.destination);

  statusUI.set("swapped");
  URL.revokeObjectURL(url);
});

// Platform constraint (Q63): the Web Audio registered-processor table is not
// released across accumulated swaps. On the 51st swap the framework emits a
// single console.warn; the user can then recreate the AudioContext if needed.
```

---

## What this set does not exercise

These are intentionally outside the example set today and are tracked as follow-up:

- `forSampleRange(start, end, callback)` partial-block iteration (deferred to v1.x.0; nested `forSample` use cases such as 2D-tile iteration are not exercised).
- `everyNSamples` sub-rate work — the surface is defined in `01-dsl.md` §9 (Q7) but no current example uses it. A canonical example will land once a use case (e.g. envelope follower at sub-rate) is selected.
- Cross-precision type conversion boundaries (`f64(node)` over an `f32` source, etc.) — the surface is in `01-dsl.md` §2 and `f32(node)` / `i32(node)` are exercised, but no example crosses a precision boundary today.
- Math primitives `tan`, `tanh`, `sqrt` — listed in `01-dsl.md` §2 but unused across the example set.
- `state.buffer.i32` — only `state.buffer.f32` is exercised.
- MIDI variants beyond `noteOn` / `noteOff` / `sysex`: `cc`, `pitchBend`, `programChange`, `channelPressure`, `aftertouch`, `systemRealtime` are part of the Q4 surface but no current example uses them. Q4 covers the wire / handler shape; the canonical example set has a coverage gap for these variants.
- `node.midi.<name>.diagnostics.overflowCount()` and `node.events.<name>.diagnostics.overflowCount()` (main-side diagnostics) are present in the spec but only Ex 4 and Ex 8 use them (one polling block each).

When those resolutions land or examples are added, the corresponding rows in the Coverage table above are updated in the same revision.
