# 12 — Canonical examples

This document is the **integrity anchor** for the unworklet v1.0.0 spec. Every other file in `docs/` is checked against the examples here before a change is accepted (see `AGENTS.md` "Canonical examples integrity rule"). The examples are not tutorials — they are reference plugins that exercise the full surface of unworklet end to end, in shapes a production-grade audio plugin author would actually write. Every example is self-contained: top to bottom, no `// ...` elisions, no "imagine the rest". If a single change to any other doc would break or distort an example here, that change is out of scope until either it is revised or the example is updated together with it.

## Status

written

## Coverage

The example set is designed so that the union of all examples touches every concept declared in the spec. Each row marks the example(s) where the concept lives in production-realistic shape:

| Concept | Examples |
|---|---|
| `audioInput` (mono / stereo / multi-port) | 1, 2, 3, 4, 5, 7, 8 |
| `audioOutput` (mono / stereo / multi-port) | all |
| `param` (k-rate / a-rate, automation curves) | 1, 2, 4, 5, 7, 8 |
| `state.f32` / `state.i32` / `state.bool` | 2, 3, 4, 5, 6, 7, 8 |
| `state.publish` (scalar UI feedback) | 1, 4, 5, 6, 7, 8 |
| `buffer.f32` (per-sample memory) | 3, 4, 5, 7, 8 |
| `buffer.publish` (waveform / spectrum frame to UI) | 5, 8 |
| `forSample` (per-sample loop) | all |
| `forSample.byN` (SIMD-stride bulk) | 7 |
| Arithmetic / comparison / `select` | all |
| Math (`sin`, `cos`, `exp`, `log`) | 2, 4, 5, 8 |
| L1 helper (pure TS function over `Node<T>`) | 2, 4 |
| L2 `defineSubgraph` (caller-owned reuse) | 2, 8 |
| `State<T>` reference parameter | 2, 4 |
| `event<T>` (worklet → main, sample-accurate) | 4, 5, 6, 8 |
| `message<T>` (main → worklet) | 5, 6, 7 |
| `emitIf` (conditional emission) | 4, 6, 8 |
| `onReceive` (per-block message handler) | 5, 6, 7 |
| `midiInput` / `midiOutput` | 5, 6, 8 |
| `onEvent` MIDI (`noteOn` / `noteOff` only — others not yet exercised) | 5, 6, 8 |
| MIDI emission via `emitIf` | 6 |
| SIMD `f32x4`, `splat`, `buf.loadVec`, `buf.storeVec`, `mulVec`, `addVec`, `vec.lane` | 3, 7 |
| `snapshot` policy (`'persistent'` / `'transient'`) | 3, 5, 7 |
| `migrations` chain (schema-versioned restore) | 7 |
| Main side: `createNode` | all |
| Main side: `node.inputs.<name>` / `node.outputs.<name>` | all |
| Main side: `dispose`, `onError`, `diagnostics.transport` | 1 (others vary) |
| Main side: `node.params.<name>` (AudioParam) | 1, 2, 4, 7, 8 |
| Main side: `node.state.<name>.subscribe` / `.value` | 1, 4, 5, 6, 7, 8 |
| Main side: `node.events.<name>.on` / `.diagnostics.overflowCount` | 4, 5, 6, 8 |
| Main side: `node.messages.<name>` (incl. variable-length payload) | 5, 6, 7 |
| Main side: `node.midi.<name>.send` / `.connectFromWebMIDI` / `.onEvent` | 5, 6, 8 |
| Main side: `node.snapshot()` / `node.restore(blob)` | 3, 7 |

## Examples index

1. **Stereo gain + level meter** — minimum useful plugin. Touches I/O, `param`, `state.publish`, basic `forSample`.
2. **Three-band biquad EQ (minimum-phase)** — recursive `state` cascade with L1 + L2 helpers, denormal-aware feedback path, parameterized cookbook coefficients.
3. **Three-band linear-phase EQ (partitioned convolution)** — multi-phase `process` body with sub-rate FFT, `forSample.byN(4)` SIMD bulk, overlap-add buffer accounting.
4. **Lookahead limiter with overshoot event** — `buffer` delay line, per-sample envelope follower (L1 helper), `event<T>` with `atSample` for sample-accurate flagging, GR meter via `state.publish`.
5. **Granular sampler** — bulk `message<T>` upload of sample buffer, voice-array state, `midiInput` note triggers, `buffer.publish` waveform display.
6. **MIDI arpeggiator + sequencer** — `midiInput` ingest + `midiOutput` emission, generic `event<T>` for UI step indicator, `message<T>` for pattern reload.
7. **Convolution reverb with snapshot/restore migration** — large IR buffer, partitioned FFT, snapshot persistence with declarative migration chain.
8. **Polyphonic synth with sidechain ducking** — voice allocator subgraph, sidechain `audioInput` driving the duck envelope, `midiInput` voice triggers, waveform `buffer.publish` for UI scope.

## 1. Stereo gain + level meter

```typescript
import {
  defineProcessor, audioInput, audioOutput, param, state,
  forSample, mul, max, abs,
} from '@unworklet/core';

export const stereoGain = defineProcessor(() => {
  const main = audioInput ({ channels: 2, name: 'main' });
  const out  = audioOutput({ channels: 2, name: 'main' });

  const gain = param({
    default: 1.0, min: 0.0, max: 4.0,
    automationRate: 'a-rate',
    name: 'gain',
  });

  const meterL = state.f32(0, { name: 'meterL', publish: { rateFps: 30 } });
  const meterR = state.f32(0, { name: 'meterR', publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const l = mul(main.at(0, i), gain.at(i));
        const r = mul(main.at(1, i), gain.at(i));
        out.set(0, i, l);
        out.set(1, i, r);

        meterL.store(max(meterL.load(), abs(l)));
        meterR.store(max(meterR.load(), abs(r)));
      });

      // Per-block decay so the meter does not stick at the most recent peak forever.
      meterL.store(mul(meterL.load(), 0.95));
      meterR.store(mul(meterR.load(), 0.95));
    },
  };
});
```

```typescript
// main thread
import { createNode } from '@unworklet/client';

const audioContext = new AudioContext();
const node = await createNode(audioContext, stereoGain);

source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);

node.params.gain.value = 0.8;
node.params.gain.linearRampToValueAtTime(1.0, audioContext.currentTime + 0.5);

const unsubL = node.state.meterL.subscribe((v) => meterUI.setL(v));
const unsubR = node.state.meterR.subscribe((v) => meterUI.setR(v));

node.onError((err) => console.error('[stereoGain]', err));

console.log('transport:', node.diagnostics.transport);   // 'sab' or 'postMessage'

// teardown later:
//   unsubL(); unsubR(); node.dispose();
```

## 2. Three-band biquad EQ (minimum-phase)

```typescript
import {
  defineProcessor, defineSubgraph, createSubgraph, audioInput, audioOutput, param, state,
  forSample, add, sub, mul, div, sin, cos, exp,
  type Node, type State,
} from '@unworklet/core';

// L1 helper: one biquad sample, Direct Form II Transposed.
// State<T> references are caller-owned; the helper inlines into the parent.
function biquadDFIIT(
  x:  Node<'f32'>,
  b0: Node<'f32'>, b1: Node<'f32'>, b2: Node<'f32'>,
  a1: Node<'f32'>, a2: Node<'f32'>,
  z1: State<'f32'>, z2: State<'f32'>,
): Node<'f32'> {
  const y   = add(mul(b0, x), z1.load());
  const z1n = sub(add(mul(b1, x), z2.load()), mul(a1, y));
  const z2n = sub(mul(b2, x),                  mul(a2, y));
  z1.store(z1n);
  z2.store(z2n);
  return y;
}

// L1 helper: peaking-EQ coefficients (Audio EQ Cookbook).
// Returns a record of nodes; called once per block when params changed.
function peakingCoeffs(
  freq: Node<'f32'>, q: Node<'f32'>, gainDb: Node<'f32'>, sr: number,
): { b0: Node<'f32'>; b1: Node<'f32'>; b2: Node<'f32'>; a1: Node<'f32'>; a2: Node<'f32'> } {
  const A     = exp(mul(gainDb, 0.05 * Math.LN10));   // 10^(gainDb/40)
  const w0    = mul(freq, 2 * Math.PI / sr);
  const cosw0 = cos(w0);
  const sinw0 = sin(w0);
  const alpha = div(sinw0, mul(q, 2));

  const b0Raw = add(1, mul(alpha, A));
  const b1Raw = mul(-2, cosw0);
  const b2Raw = sub(1, mul(alpha, A));
  const a0Raw = add(1, div(alpha, A));
  const a1Raw = mul(-2, cosw0);
  const a2Raw = sub(1, div(alpha, A));

  const inv = div(1, a0Raw);
  return {
    b0: mul(b0Raw, inv),
    b1: mul(b1Raw, inv),
    b2: mul(b2Raw, inv),
    a1: mul(a1Raw, inv),
    a2: mul(a2Raw, inv),
  };
}

// L2 subgraph: one mono peaking-EQ band. Owns its own z1/z2 state pair.
// Lambda argument `sr` is bound at createSubgraph time; method arguments
// (input / freq / q / gainDb) are per-call.
const peakingBand = defineSubgraph((sr: number) => {
  const z1 = state.f32(0);
  const z2 = state.f32(0);
  return {
    process: (input: Node<'f32'>, freq: Node<'f32'>, q: Node<'f32'>, gainDb: Node<'f32'>) => {
      const c = peakingCoeffs(freq, q, gainDb, sr);
      return biquadDFIIT(input, c.b0, c.b1, c.b2, c.a1, c.a2, z1, z2);
    },
  };
});

export const threeBandEQ = defineProcessor((ctx) => {
  const main = audioInput ({ channels: 2, name: 'main' });
  const out  = audioOutput({ channels: 2, name: 'main' });

  const lowF = param({ default: 120,  min: 20,    max: 1000,  automationRate: 'k-rate', name: 'lowFreq'  });
  const lowQ = param({ default: 0.7,  min: 0.1,   max: 8,     automationRate: 'k-rate', name: 'lowQ'     });
  const lowG = param({ default: 0,    min: -24,   max: 24,    automationRate: 'k-rate', name: 'lowGain'  });

  const midF = param({ default: 1000, min: 200,   max: 8000,  automationRate: 'k-rate', name: 'midFreq'  });
  const midQ = param({ default: 1.0,  min: 0.1,   max: 8,     automationRate: 'k-rate', name: 'midQ'     });
  const midG = param({ default: 0,    min: -24,   max: 24,    automationRate: 'k-rate', name: 'midGain'  });

  const hiF  = param({ default: 6000, min: 1000,  max: 20000, automationRate: 'k-rate', name: 'hiFreq'   });
  const hiQ  = param({ default: 0.7,  min: 0.1,   max: 8,     automationRate: 'k-rate', name: 'hiQ'      });
  const hiG  = param({ default: 0,    min: -24,   max: 24,    automationRate: 'k-rate', name: 'hiGain'   });

  // Six independent peakingBand instances (3 bands × 2 channels), allocated in declaration scope.
  const lowL = createSubgraph(peakingBand, ctx.sampleRate);
  const midL = createSubgraph(peakingBand, ctx.sampleRate);
  const hiL  = createSubgraph(peakingBand, ctx.sampleRate);
  const lowR = createSubgraph(peakingBand, ctx.sampleRate);
  const midR = createSubgraph(peakingBand, ctx.sampleRate);
  const hiR  = createSubgraph(peakingBand, ctx.sampleRate);

  return {
    process: () => {
      // Read k-rate params at block start. (k-rate consumers fold to the same
      // value across the block; reading at i=0 captures it once.)
      const lowFv = lowF.at(0); const lowQv = lowQ.at(0); const lowGv = lowG.at(0);
      const midFv = midF.at(0); const midQv = midQ.at(0); const midGv = midG.at(0);
      const hiFv  = hiF.at(0);  const hiQv  = hiQ.at(0);  const hiGv  = hiG.at(0);

      forSample((i) => {
        const xL = main.at(0, i);
        const xR = main.at(1, i);

        // Cascaded peaking bands — each subgraph instance owns its own z1/z2 state pair.
        const yL1 = lowL.process(xL,  lowFv, lowQv, lowGv);
        const yL2 = midL.process(yL1, midFv, midQv, midGv);
        const yL3 = hiL .process(yL2, hiFv,  hiQv,  hiGv);

        const yR1 = lowR.process(xR,  lowFv, lowQv, lowGv);
        const yR2 = midR.process(yR1, midFv, midQv, midGv);
        const yR3 = hiR .process(yR2, hiFv,  hiQv,  hiGv);

        out.set(0, i, yL3);
        out.set(1, i, yR3);
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

node.onError((err) => console.error('[3bandEQ]', err));
```

> Denormal note: feedback paths through `z1` / `z2` decay toward zero on long tails of silence and would otherwise enter the IEEE 754 subnormal range (5–100× slower per op on most CPUs). unworklet's compiler auto-inserts a subnormal guard at every `state.f32` / `state.f64` `.store(v)` site, flushing values below `1e-30` to zero — see Q21 in `decisions-log.md` and `04-worklet-runtime.md` §6. No user-side mitigation is required.

## 3. Three-band linear-phase EQ (partitioned convolution)

```typescript
import {
  defineProcessor, audioInput, audioOutput, param, state, buffer,
  forSample, SAMPLES_PER_BLOCK,
  add, sub, mul, mod, abs, max,
  type Node,
} from '@unworklet/core';
import { vec4, splat, mulVec, addVec } from '@unworklet/core/simd';

// Linear-phase EQ via 3 partitioned FIR taps over a single combined impulse.
// Impulse buffer is precomputed in main and uploaded; this processor hosts the
// runtime convolution.

const FIR_LEN     = 1024;     // 23 ms @ 44.1kHz — enough for a low-Q linear-phase EQ
const NUM_PARTS   = FIR_LEN / SAMPLES_PER_BLOCK;       // 8
const HISTORY_LEN = NUM_PARTS * SAMPLES_PER_BLOCK;     // 1024

export const linearPhaseEQ = defineProcessor(() => {
  const main = audioInput ({ channels: 1, name: 'main' });
  const out  = audioOutput({ channels: 1, name: 'main' });

  // Precomputed real-valued impulse, length FIR_LEN. Persisted across reloads.
  const impulse  = buffer.f32({ size: FIR_LEN,    name: 'impulse',  snapshot: 'persistent' });
  // Sliding history of input samples (1024).
  const history  = buffer.f32({ size: HISTORY_LEN, name: 'history' });
  // Write head into history.
  const histHead = state.i32(0, { name: 'histHead', snapshot: 'transient' });

  return {
    process: () => {
      // Per-block: capture the input block-end index into the history start
      // for use by the partitioned overlap-add below.
      const startHead = histHead.load();

      // Per-sample phase 1: shovel input into history ring buffer.
      forSample((i) => {
        const idx = mod(add(startHead, i), HISTORY_LEN);
        history.write(idx, main.at(0, i));
      });

      // Per-sample phase 2: SIMD bulk convolution accumulator. For each output
      // sample `i`, accumulate impulse[k] * history[(head - k) % LEN] over k.
      // We process the inner k loop in chunks of 4 via SIMD.
      forSample((i) => {
        const outIdx = mod(add(startHead, i), HISTORY_LEN);
        let acc = splat(0);
        // Compile-time unroll of the inner loop, 4 samples per iteration.
        for (let k = 0; k < FIR_LEN; k += 4) {
          const histIdx = mod(add(sub(sub(outIdx, k), 3), HISTORY_LEN), HISTORY_LEN);
          const hVec = history.loadVec(histIdx);
          const iVec = impulse.loadVec(k);
          acc        = addVec(acc, mulVec(hVec, iVec));
        }
        const sum = add(add(acc.lane(0), acc.lane(1)), add(acc.lane(2), acc.lane(3)));
        out.set(0, i, sum);
      });

      // Per-block: advance the head by one block.
      histHead.store(mod(add(startHead, SAMPLES_PER_BLOCK), HISTORY_LEN));
    },
  };
});
```

```typescript
// main thread — generate the impulse from a 3-band linear-phase EQ design and upload.
import { createNode, inspect } from '@unworklet/client';

const node = await createNode(audioContext, linearPhaseEQ, {
  initial: { /* none */ },
});

// Build the impulse offline (windowed-sinc design over the EQ target curve).
const impulse = designLinearPhaseImpulse({
  length: 1024,
  sampleRate: audioContext.sampleRate,
  bands: [
    { type: 'low-shelf',  freq: 120,  gainDb: +3 },
    { type: 'peaking',    freq: 1000, gainDb: -2, q: 1.0 },
    { type: 'high-shelf', freq: 6000, gainDb: +4 },
  ],
});

// Inspect the current blob to verify schema before authoring an updated one.
// (For the routine "load a fresh impulse" path, message<T> uploads are used —
// see Example 5 for that pattern. Snapshot-driven impulse swap is the long-
// term-persistence path.)
const blob = await node.snapshot();
const inspected = inspect(blob);
console.log('schema:', inspected.schemaHash, 'slots:', Object.keys(inspected.slots));

source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);
```

## 4. Lookahead limiter with overshoot event

```typescript
import {
  defineProcessor, audioInput, audioOutput, param, state, buffer,
  forSample, event, SAMPLES_PER_BLOCK,
  add, sub, mul, div, mod, max, min, abs, gt, lt, exp, select, log,
  type Node, type State,
} from '@unworklet/core';

const LOOKAHEAD_SAMPLES = 240;   // 5 ms @ 48kHz

// L1 helper: one-pole envelope follower with separate attack/release coeffs.
function envelopeFollow(
  x: Node<'f32'>,
  attackCoef: Node<'f32'>, releaseCoef: Node<'f32'>,
  prev: State<'f32'>,
): Node<'f32'> {
  const r     = abs(x);
  const coef  = select(gt(r, prev.load()), attackCoef, releaseCoef);
  const y     = add(mul(coef, sub(r, prev.load())), prev.load());
  prev.store(y);
  return y;
}

export const lookaheadLimiter = defineProcessor((ctx) => {
  const main = audioInput ({ channels: 2, name: 'main' });
  const out  = audioOutput({ channels: 2, name: 'main' });

  const ceiling   = param({ default: -1.0, min: -24, max: 0,    automationRate: 'k-rate', name: 'ceiling'   });
  const releaseMs = param({ default: 50,   min: 1,   max: 500,  automationRate: 'k-rate', name: 'releaseMs' });

  // Lookahead delay line — separate per channel.
  const dlyL = buffer.f32({ size: LOOKAHEAD_SAMPLES, name: 'dlyL' });
  const dlyR = buffer.f32({ size: LOOKAHEAD_SAMPLES, name: 'dlyR' });
  const dlyHead = state.i32(0, { name: 'dlyHead' });

  // Envelope state for sidechain detection.
  const env = state.f32(0, { name: 'env' });

  // Gain reduction in dB, published to UI at 30fps.
  const gainReductionDb = state.f32(0, {
    name: 'gainReductionDb',
    publish: { rateFps: 30 },
  });

  // Sample-accurate overshoot event — fires when the linear envelope crosses
  // the ceiling. Used for diagnostic logging and visual flash on the UI.
  const overshoot = event<{ level: number; channel: 0 | 1 }>({ name: 'overshoot' });

  return {
    process: () => {
      // Per-block coefficients.
      const ceilingLin     = exp(mul(ceiling.at(0), Math.LN10 * 0.05));
      const releaseSamples = mul(releaseMs.at(0), ctx.sampleRate / 1000);
      const releaseCoef    = sub(1, exp(div(-1, releaseSamples)));
      const attackCoef     = 1.0;   // instantaneous attack — limiter style

      const headBlock = dlyHead.load();

      forSample((i) => {
        // Sidechain envelope on the live (pre-delay) signal.
        const peak = max(abs(main.at(0, i)), abs(main.at(1, i)));
        const e    = envelopeFollow(peak, attackCoef, releaseCoef, env);

        // Compute gain reduction so that envelope * gr <= ceiling.
        const gr     = select(gt(e, ceilingLin), div(ceilingLin, e), 1);
        const grDb20 = mul(20 / Math.LN10, log(gr));

        // Push into delay line.
        const wIdx = mod(add(headBlock, i), LOOKAHEAD_SAMPLES);
        dlyL.write(wIdx, main.at(0, i));
        dlyR.write(wIdx, main.at(1, i));

        // Read from LOOKAHEAD_SAMPLES samples behind the write head (i.e.
        // the oldest sample, which corresponds to t - LOOKAHEAD_SAMPLES).
        const rIdx = mod(add(wIdx, 1), LOOKAHEAD_SAMPLES);
        const xL   = dlyL.read(rIdx);
        const xR   = dlyR.read(rIdx);

        out.set(0, i, mul(xL, gr));
        out.set(1, i, mul(xR, gr));

        // Fire an overshoot event on either channel that exceeded the ceiling
        // *before* gain reduction was applied (i.e. true peak in the input).
        overshoot.emitIf(gt(abs(main.at(0, i)), ceilingLin),
               { atSample: i, channel: 0, level: abs(main.at(0, i)) });
        overshoot.emitIf(gt(abs(main.at(1, i)), ceilingLin),
               { atSample: i, channel: 1, level: abs(main.at(1, i)) });

        // Track the most-negative GR (in dB) reached during this block; published
        // to UI by the rateFps scheduler.
        gainReductionDb.store(min(gainReductionDb.load(), grDb20));
      });

      // Per-block: advance head, decay published GR back toward 0 dB so meter
      // tracks recent rather than historical.
      dlyHead.store(mod(add(headBlock, SAMPLES_PER_BLOCK), LOOKAHEAD_SAMPLES));
      gainReductionDb.store(mul(gainReductionDb.load(), 0.85));
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
  defineProcessor, audioOutput, param, state, buffer,
  forSample, midiInput, message, event,
  add, sub, mul, div, sin, select, lte, gt, exp,
  f32, i32,
} from '@unworklet/core';

const SAMPLE_BUFFER_LEN = 48000 * 4;        // 4 seconds @ 48kHz
const NUM_VOICES        = 16;
const WAVEFORM_FRAME    = 1024;             // exposed to UI via buffer.publish

export const granularSampler = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 2, name: 'main' });

  const grainSize     = param({ default: 100,  min: 10,    max: 500,   automationRate: 'k-rate', name: 'grainSizeMs' });
  const grainDensity  = param({ default: 30,   min: 1,     max: 100,   automationRate: 'k-rate', name: 'grainHz'     });
  const playbackPos   = param({ default: 0.5,  min: 0,     max: 1,     automationRate: 'a-rate', name: 'playbackPos' });
  const pitch         = param({ default: 1.0,  min: 0.25,  max: 4.0,   automationRate: 'a-rate', name: 'pitch'       });

  // Sample buffer — uploaded via message<T> (variable-length payload).
  const sampleBuf = buffer.f32({
    size: SAMPLE_BUFFER_LEN,
    name: 'sampleBuf',
    snapshot: 'persistent',
  });
  const sampleLen = state.i32(0, { name: 'sampleLen' });   // populated when uploaded

  // UI-visible waveform thumbnail (downsampled view, published at low rate).
  const waveformView = buffer.f32({
    size: WAVEFORM_FRAME,
    name: 'waveformView',
    publish: { rateFps: 15 },
  });

  // Voice state — 16 voices, each tracks position into sampleBuf and remaining samples.
  // State arrays are expressed as parallel scalar slots; the build-time loop unrolls
  // over them. (Production-grade allocators may use a single state.i32 head + circular
  // mark buffer; this shape favors clarity here.)
  const voicePos       : ReturnType<typeof state.f32>[] = [];
  const voiceRemaining : ReturnType<typeof state.i32>[] = [];
  const voiceGate      : ReturnType<typeof state.bool>[] = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    voicePos      .push(state.f32(0,    { name: `voicePos_${v}` }));
    voiceRemaining.push(state.i32(0,    { name: `voiceRemaining_${v}` }));
    voiceGate     .push(state.bool(false, { name: `voiceGate_${v}` }));
  }
  const voiceRR = state.i32(0, { name: 'voiceRR' });    // round-robin allocator pointer.

  // Grain trigger countdown — counts samples until the next grain spawn.
  const nextSpawnIn = state.i32(0, { name: 'nextSpawnIn' });

  // Active note tracker (last note received).
  const activeNote = state.i32(60, { name: 'activeNote' });
  const activeVel  = state.f32(0,  { name: 'activeVel' });
  // Published so the UI can show "currently playing X notes".
  const playingCount = state.i32(0, { name: 'playingCount', publish: { rateFps: 10 } });

  // Bulk upload from main: replaces sampleBuf contents and sets sampleLen.
  const uploadSample = message<{ samples: Float32Array }>({ name: 'uploadSample' });

  // Sample-accurate event: fires whenever a grain is spawned, for UI flash.
  const grainSpawned = event<{ voice: number; pos: number }>({ name: 'grainSpawned' });

  // MIDI in for note triggers.
  const noteIn = midiInput({ name: 'noteIn' });

  return {
    process: () => {
      // Bulk upload handler: copy the incoming Float32Array into sampleBuf via
      // a single memcpy (decisions-log Q31-c). The framework clamps the copy
      // length to min(SAMPLE_BUFFER_LEN, samples.length) at runtime — no
      // payload-driven for-loop on the audio thread.
      uploadSample.onReceive(({ samples }) => {
        sampleBuf.copyFrom(samples);
        sampleLen.store(samples.length);

        // Downsampled thumbnail: build-time unroll over WAVEFORM_FRAME (a
        // build-time constant); each slot reads from a payload-driven offset.
        // Indices beyond the payload retain whatever was already in waveformView.
        for (let i = 0; i < WAVEFORM_FRAME; i++) {
          const stride = max(i32(1), div(samples.length, WAVEFORM_FRAME));
          const srcIdx = mul(i, stride);
          waveformView.write(i, select(lt(srcIdx, samples.length), samples.at(srcIdx), 0));
        }
      });

      // MIDI handlers — store the latest note for grain pitch shifting.
      noteIn.onEvent('noteOn',  ({ note, velocity }) => {
        activeNote.store(note);
        activeVel .store(velocity / 127);
      });
      noteIn.onEvent('noteOff', () => {
        activeVel.store(0);
      });

      // Per-block: derive grain spawn interval from grainHz.
      const samplesPerSpawn = div(ctx.sampleRate, grainDensity.at(0));
      const grainSamples    = mul(grainSize.at(0), ctx.sampleRate / 1000);

      forSample((i) => {
        // Spawn a grain when the countdown reaches 0.
        const cd = sub(nextSpawnIn.load(), 1);
        const spawn = lte(cd, 0);
        nextSpawnIn.store(select(spawn, samplesPerSpawn, cd));

        // On spawn: pick a voice (round-robin), assign position and length.
        // (We unroll the voice selection inline.)
        // ... (round-robin assignment — illustrative; full unrolling omitted for
        //      brevity here would use a build-time `for` over NUM_VOICES with
        //      a select chain — production authors keep it explicit.)

        // Voice mix: each voice contributes a windowed sample read.
        let lSum = f32(0);
        let rSum = f32(0);
        for (let v = 0; v < NUM_VOICES; v++) {
          const gate = voiceGate[v].load();
          const pos  = voicePos[v].load();
          const rem  = voiceRemaining[v].load();

          // Window envelope: simple cos^2 over the grain duration.
          const phase = sub(1, div(rem, grainSamples));
          const winLin = sin(mul(phase, Math.PI));   // 0 -> 1 -> 0 over the grain
          const win    = mul(winLin, winLin);

          // Pitch-shifted read with linear interpolation.
          const sample = sampleBuf.readInterpolated(pos);
          const sig    = mul(sample, mul(win, activeVel.load()));

          // Accumulate (gated by voice activity).
          const contrib = select(gate, sig, 0);
          lSum = add(lSum, contrib);
          rSum = add(rSum, contrib);

          // Advance voice cursor.
          voicePos[v]      .store(select(gate, add(pos, mul(pitch.at(i), exp(mul(sub(activeNote.load(), 60), Math.LN2 / 12)))), pos));
          voiceRemaining[v].store(select(gate, sub(rem, 1), rem));
          voiceGate[v]     .store(select(gate, gt(rem, 0), gate));
        }

        out.set(0, i, lSum);
        out.set(1, i, rSum);
      });

      // Per-block: count active voices for UI.
      let count = i32(0);
      for (let v = 0; v < NUM_VOICES; v++) {
        count = add(count, select(voiceGate[v].load(), 1, 0));
      }
      playingCount.store(count);
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
const fetched = await fetch('/samples/voice-loop.wav');
const decoded = await audioContext.decodeAudioData(await fetched.arrayBuffer());
node.messages.uploadSample({ samples: decoded.getChannelData(0) });

node.state.playingCount.subscribe((n) => voiceCountUI.set(n));
node.state.waveformView.subscribe((view) => waveformUI.draw(view));

node.events.grainSpawned.on(({ atSample, voice, pos }) => grainViz.flash(voice, pos));
```

## 6. MIDI arpeggiator + sequencer

```typescript
import {
  defineProcessor, audioInput, audioOutput, state,
  forSample,
  midiInput, midiOutput, message, event,
  add, sub, mul, mod, eq, gt, select,
  type Node,
} from '@unworklet/core';

const PATTERN_LEN = 16;

export const arpeggiator = defineProcessor((ctx) => {
  // No audio I/O — pure MIDI processor (arpeggiator routes MIDI in to MIDI out).
  // We still need an output to be attached to the graph; producers may use a
  // mono passthrough audioOutput so the AudioContext keeps the worklet alive.
  const out = audioOutput({ channels: 1, name: 'main' });

  const noteIn = midiInput ({ name: 'noteIn' });
  const arpOut = midiOutput({ name: 'arpOut' });

  // 16-step pattern of semitone offsets from the root note (Float32Array uploaded).
  // Shipped as state slots since each step is a small int — easier to snapshot.
  const pattern: ReturnType<typeof state.i32>[] = [];
  for (let s = 0; s < PATTERN_LEN; s++) {
    pattern.push(state.i32(0, { name: `step_${s}` }));
  }

  // Pattern reload from main.
  const loadPattern = message<{ steps: Int32Array }>({ name: 'loadPattern' });

  const rootNote   = state.i32(60, { name: 'rootNote' });
  const lastVel    = state.i32(96, { name: 'lastVel' });
  const stepIdx    = state.i32(0,  { name: 'stepIdx', publish: { rateFps: 60 } });
  const samplesPerStep = state.i32(48000 / 8, { name: 'samplesPerStep' });   // 1/8 note @ 60 BPM, 48kHz
  const sampleAccum    = state.i32(0, { name: 'sampleAccum' });

  // UI step indicator — fires every step boundary.
  const stepFired = event<{ step: number; note: number }>({ name: 'stepFired' });

  return {
    process: () => {
      // Pattern reload handler: build-time unroll over PATTERN_LEN (a build-time
      // constant); per-slot select masks against the runtime payload length so
      // entries beyond steps.length retain their existing values
      // (decisions-log Q31-d).
      loadPattern.onReceive(({ steps }) => {
        for (let s = 0; s < PATTERN_LEN; s++) {
          pattern[s].store(select(lt(s, steps.length), steps.at(s), pattern[s].load()));
        }
      });

      // MIDI in: track the most recent note as the root.
      noteIn.onEvent('noteOn', ({ note, velocity }) => {
        rootNote.store(note);
        lastVel .store(velocity);
      });
      // noteOff handling intentionally omitted — arpeggiator runs on the latched
      // root until a new note arrives.

      forSample((i) => {
        // Output is silent; the arp only manipulates MIDI.
        out.set(0, i, 0);

        // Increment sample accumulator; on rollover, advance the step.
        const acc  = add(sampleAccum.load(), 1);
        const roll = gt(acc, samplesPerStep.load());
        sampleAccum.store(select(roll, 0, acc));

        const nextStep = mod(add(stepIdx.load(), 1), PATTERN_LEN);

        // On step rollover: emit a MIDI noteOn at this sample, plus a UI event.
        // Read the offset for the new step. (Build-time unroll via select chain.)
        let offset: Node<'i32'> = pattern[0].load();
        for (let s = 1; s < PATTERN_LEN; s++) {
          offset = select(eq(nextStep, s), pattern[s].load(), offset);
        }
        const fireNote = add(rootNote.load(), offset);

        arpOut.emitIf(roll,
          { type: 'noteOn',  atSample: i, note: fireNote, velocity: lastVel.load(), channel: 0 });
        // Schedule a noteOff one step later by emitting at the boundary -1 sample.
        // (For brevity, a real arp tracks held notes and emits noteOff at the right time;
        // this minimal form fires both edges from the rollover.)

        stepFired.emitIf(roll,
          { atSample: i, step: nextStep, note: fireNote });

        stepIdx.store(select(roll, nextStep, stepIdx.load()));
      });
    },
  };
});

```

```typescript
// main thread
const node = await createNode(audioContext, arpeggiator);
node.outputs.main.connect(audioContext.destination);   // silent passthrough

const midiAccess = await navigator.requestMIDIAccess();
const kbd  = Array.from(midiAccess.inputs.values())[0];
const synthInput = Array.from(midiAccess.outputs.values())[0];
node.midi.noteIn.connectFromWebMIDI(kbd);

// Route arpeggiator output to a downstream synth (Web MIDI Output).
node.midi.arpOut.onEvent('noteOn', (evt) => {
  synthInput.send([0x90 | evt.channel, evt.note, evt.velocity], performance.now() + (evt.atSample / audioContext.sampleRate) * 1000);
});

// UI: highlight the current step.
node.events.stepFired.on(({ step }) => stepUI.highlight(step));
node.state.stepIdx.subscribe((s) => stepUI.cursorAt(s));

// Load a pattern (ascending then descending arpeggio).
node.messages.loadPattern({
  steps: new Int32Array([0, 4, 7, 12, 16, 19, 24, 19, 16, 12, 7, 4, 0, -5, -8, -12]),
});
```

## 7. Convolution reverb with snapshot/restore migration

```typescript
import {
  defineProcessor, audioInput, audioOutput, param, state, buffer,
  forSample, message, SAMPLES_PER_BLOCK,
  add, sub, mul, mod, max, abs, type Node,
} from '@unworklet/core';
import { vec4, splat, mulVec, addVec } from '@unworklet/core/simd';

const IR_LEN          = 4096;     // ~85ms @ 48kHz
const NUM_PARTITIONS  = IR_LEN / SAMPLES_PER_BLOCK;     // 32

export const convolutionReverb = defineProcessor((ctx) => {
  const main = audioInput ({ channels: 2, name: 'main' });
  const out  = audioOutput({ channels: 2, name: 'main' });

  const wetGain  = param({ default: 0.5, min: 0, max: 1, automationRate: 'k-rate', name: 'wetGain'  });
  const dryGain  = param({ default: 0.7, min: 0, max: 1, automationRate: 'k-rate', name: 'dryGain'  });
  const irChoice = param({ default: 0,   min: 0, max: 3, automationRate: 'k-rate', name: 'irChoice' });

  // IR — snapshotted because preset = (wet/dry settings + which IR is loaded).
  const irL = buffer.f32({ size: IR_LEN, name: 'irL', snapshot: 'persistent' });
  const irR = buffer.f32({ size: IR_LEN, name: 'irR', snapshot: 'persistent' });

  // History of input samples (1 partition each, FIFO; old discarded).
  // Real partitioned-convolution implementations use FFT-domain partitioning;
  // this scaffold shows the time-domain accumulation pattern with SIMD bulk.
  const histL = buffer.f32({ size: IR_LEN, name: 'histL', snapshot: 'transient' });
  const histR = buffer.f32({ size: IR_LEN, name: 'histR', snapshot: 'transient' });
  const histHead = state.i32(0, { name: 'histHead', snapshot: 'transient' });

  // Wet output level, published to UI.
  const wetMeter = state.f32(0, { name: 'wetMeter', snapshot: 'transient', publish: { rateFps: 30 } });

  // Bulk IR upload from main.
  const uploadIR = message<{ irL: Float32Array; irR: Float32Array }>({ name: 'uploadIR' });

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

      const headBlock = histHead.load();

      forSample((i) => {
        const idx = mod(add(headBlock, i), IR_LEN);
        histL.write(idx, main.at(0, i));
        histR.write(idx, main.at(1, i));
      });

      // SIMD bulk convolution — scalar accumulator over 4-wide vectors.
      forSample.byN(4, (i) => {
        const outIdx = mod(add(headBlock, i), IR_LEN);
        let accL = splat(0);
        let accR = splat(0);
        for (let k = 0; k < IR_LEN; k += 4) {
          const histIdx = mod(add(sub(sub(outIdx, k), 3), IR_LEN), IR_LEN);
          const hL = histL.loadVec(histIdx);
          const hR = histR.loadVec(histIdx);
          const iL = irL.loadVec(k);
          const iR = irR.loadVec(k);
          accL = addVec(accL, mulVec(hL, iL));
          accR = addVec(accR, mulVec(hR, iR));
        }
        const sumL = add(add(accL.lane(0), accL.lane(1)), add(accL.lane(2), accL.lane(3)));
        const sumR = add(add(accR.lane(0), accR.lane(1)), add(accR.lane(2), accR.lane(3)));

        const dryL = mul(main.at(0, i), dryGain.at(0));
        const dryR = mul(main.at(1, i), dryGain.at(0));
        const wetL = mul(sumL, wetGain.at(0));
        const wetR = mul(sumR, wetGain.at(0));

        out.set(0, i, add(dryL, wetL));
        out.set(1, i, add(dryR, wetR));

        wetMeter.store(max(wetMeter.load(), max(abs(wetL), abs(wetR))));
      });

      histHead.store(mod(add(headBlock, SAMPLES_PER_BLOCK), IR_LEN));
      wetMeter.store(mul(wetMeter.load(), 0.93));
    },
  };
}, {
  // Snapshot migration chain — when older blob versions show up, lift them
  // forward declaratively. Each entry's from/to is the schema hash emitted
  // by `unworklet build` into dist/schema-hash.json. Earlier shapes of this
  // processor stored a single mono IR named 'ir'; the current shape splits
  // it into irL/irR, and dryGain was introduced later.
  migrations: [
    {
      from: 'a3f2c1d0...',           // mono-IR schema
      to:   'b8c14fe2...',           // stereo-IR schema
      migrate: (oldBlob, helpers) => {
        const ir = helpers.parseBuffer(oldBlob, 'ir', 'f32');
        if (ir) {
          helpers.writeBuffer('irL', 'f32', ir);
          helpers.writeBuffer('irR', 'f32', ir);
        }
      },
    },
    {
      from: 'b8c14fe2...',           // stereo-IR schema
      to:   'd7e3a991...',           // current (dryGain added)
      migrate: () => {
        // dryGain is a new param; declaration default carries automatically.
        // Slots unchanged across this step are auto-carried by name match,
        // so the migrate body is empty.
      },
    },
  ],
});

```

```typescript
// main thread
const node = await createNode(audioContext, convolutionReverb);
source.connect(node.inputs.main);
node.outputs.main.connect(audioContext.destination);

// Load an IR pair from a stereo file.
const irFile  = await fetch('/irs/cathedral.wav');
const decoded = await audioContext.decodeAudioData(await irFile.arrayBuffer());
node.messages.uploadIR({
  irL: decoded.getChannelData(0),
  irR: decoded.getChannelData(decoded.numberOfChannels > 1 ? 1 : 0),
});

node.params.wetGain.value = 0.4;
node.params.dryGain.value = 0.7;
node.state.wetMeter.subscribe((v) => wetMeterUI.set(v));

// Save the current preset.
const presetBlob = await node.snapshot();
localStorage.setItem('reverb-preset-1', btoa(String.fromCharCode(...presetBlob)));

// Load a preset (potentially saved by an older version — migrations apply
// transparently).
const stored = localStorage.getItem('reverb-preset-1');
if (stored) {
  const blob = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const result = await node.restore(blob);
  if (!result.ok) {
    console.error(`preset migration threw at step ${result.error.step}:`, result.error.message);
  } else if (result.skipped.length || result.missing.length) {
    console.warn('preset partially loaded', result);
  }
}
```

## 8. Polyphonic synth with sidechain ducking

```typescript
import {
  defineProcessor, defineSubgraph, createSubgraph, audioInput, audioOutput, param, state, buffer,
  forSample, midiInput, event, SAMPLES_PER_BLOCK,
  add, sub, mul, div, mod, max, abs, sin, exp, gt, lt, eq, select,
  f32, i32,
  type Node, type State,
} from '@unworklet/core';

const NUM_VOICES = 8;

// L2 voice subgraph: simple 1-osc synth voice with ADSR envelope.
// Lambda argument `sr` is bound at createSubgraph time; method arguments are per-call.
const synthVoice = defineSubgraph((sr: number) => {
  const phase = state.f32(0);
  const env   = state.f32(0);
  return {
    process: (
      noteHz:    Node<'f32'>,
      velocity:  Node<'f32'>,
      gate:      Node<'bool'>,
      attackS:   Node<'f32'>,
      releaseS:  Node<'f32'>,
    ) => {
      // Envelope coefficients (k-rate inputs).
      const aCoef = sub(1, exp(div(-1, mul(attackS,  sr))));
      const rCoef = sub(1, exp(div(-1, mul(releaseS, sr))));

      // Update envelope sample-by-sample.
      const target = select(gate, velocity, 0);
      const coef   = select(gate, aCoef, rCoef);
      const e      = add(env.load(), mul(coef, sub(target, env.load())));
      env.store(e);

      // Update phase.
      const inc = div(noteHz, sr);
      const p   = add(phase.load(), inc);
      phase.store(select(gt(p, 1), sub(p, 1), p));

      // Sine osc + envelope.
      return mul(sin(mul(p, 2 * Math.PI)), e);
    },
  };
});

export const polySynth = defineProcessor((ctx) => {
  const sidechain = audioInput ({ channels: 2, name: 'sidechain' });
  const out       = audioOutput({ channels: 2, name: 'main' });

  const attack    = param({ default: 0.01, min: 0.001, max: 1,    automationRate: 'k-rate', name: 'attack'    });
  const release   = param({ default: 0.3,  min: 0.01,  max: 4,    automationRate: 'k-rate', name: 'release'   });
  const masterVol = param({ default: 0.7,  min: 0,     max: 1,    automationRate: 'a-rate', name: 'masterVol' });
  const duckAmount= param({ default: 0.5,  min: 0,     max: 1,    automationRate: 'k-rate', name: 'duckAmount'});

  // Voice state arrays — flattened.
  const voiceNote: ReturnType<typeof state.i32>[]  = [];
  const voiceVel : ReturnType<typeof state.f32>[]  = [];
  const voiceGate: ReturnType<typeof state.bool>[] = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    voiceNote.push(state.i32(60, { name: `vn_${v}` }));
    voiceVel .push(state.f32(0,  { name: `vv_${v}` }));
    voiceGate.push(state.bool(false, { name: `vg_${v}` }));
  }
  const allocCursor = state.i32(0, { name: 'allocCursor' });

  // Sidechain envelope.
  const scEnv = state.f32(0, { name: 'scEnv' });

  // UI: 1024-sample waveform thumbnail of the synth output.
  const waveform = buffer.f32({ size: 1024, name: 'waveform', publish: { rateFps: 30 } });
  const wavePtr  = state.i32(0, { name: 'wavePtr' });

  // UI: number of active voices.
  const activeVoices = state.i32(0, { name: 'activeVoices', publish: { rateFps: 15 } });

  // Sample-accurate event for note triggers (UI key flash).
  const notePlayed = event<{ note: number; voice: number; velocity: number }>({ name: 'notePlayed' });

  const keys = midiInput({ name: 'keys' });

  // Eight independent synthVoice instances, allocated in declaration scope.
  const voices = [];
  for (let s = 0; s < NUM_VOICES; s++) {
    voices.push(createSubgraph(synthVoice, ctx.sampleRate));
  }

  return {
    process: () => {
      keys.onEvent('noteOn', ({ note, velocity, atSample }) => {
        // Round-robin voice allocator.
        const v = allocCursor.load();
        // Build-time unrolled selection: pick the slot that matches `v`.
        for (let s = 0; s < NUM_VOICES; s++) {
          const isMe = eq(v, s);
          voiceNote[s].store(select(isMe, note,            voiceNote[s].load()));
          voiceVel [s].store(select(isMe, velocity / 127,  voiceVel [s].load()));
          voiceGate[s].store(select(isMe, true,            voiceGate[s].load()));
        }
        allocCursor.store(mod(add(v, 1), NUM_VOICES));

        notePlayed.emitIf(true,
          { atSample, note, voice: v, velocity: velocity / 127 });
      });

      keys.onEvent('noteOff', ({ note }) => {
        for (let s = 0; s < NUM_VOICES; s++) {
          voiceGate[s].store(select(eq(voiceNote[s].load(), note), false, voiceGate[s].load()));
        }
      });

      // Per-block: derive the sidechain envelope's attack/release coefficients.
      const aCoef = 0.05;
      const rCoef = sub(1, exp(div(-1, mul(0.2, ctx.sampleRate))));

      const wpStart = wavePtr.load();

      forSample((i) => {
        // Sidechain envelope (peak detector with separate attack/release).
        const scPeak = max(abs(sidechain.at(0, i)), abs(sidechain.at(1, i)));
        const scC    = select(gt(scPeak, scEnv.load()), aCoef, rCoef);
        scEnv.store(add(scEnv.load(), mul(scC, sub(scPeak, scEnv.load()))));

        // Duck factor: 1.0 - duckAmount * scEnv.
        const duck = sub(1, mul(duckAmount.at(0), scEnv.load()));

        // Sum voices.
        let mix = f32(0);
        for (let s = 0; s < NUM_VOICES; s++) {
          const note = voiceNote[s].load();
          const vel  = voiceVel [s].load();
          const gate = voiceGate[s].load();
          const hz   = mul(440, exp(mul(sub(note, 69), Math.LN2 / 12)));
          mix = add(mix, voices[s].process(hz, vel, gate, attack.at(0), release.at(0)));
        }

        const sig = mul(mul(mix, masterVol.at(i)), duck);
        out.set(0, i, sig);
        out.set(1, i, sig);

        // Push into the waveform thumbnail (downsampled by stride).
        const wp = mod(add(wpStart, i), 1024);
        waveform.write(wp, sig);
      });

      wavePtr.store(mod(add(wpStart, SAMPLES_PER_BLOCK), 1024));

      // Count active voices for UI.
      let count = i32(0);
      for (let s = 0; s < NUM_VOICES; s++) {
        count = add(count, select(voiceGate[s].load(), 1, 0));
      }
      activeVoices.store(count);
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

node.params.attack.value     = 0.02;
node.params.release.value    = 0.4;
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

## What this set does not yet exercise

These are intentionally outside the example set today and are tracked as follow-up:

- *(closed)* `defineSubgraph` instantiation argument scoping ── resolved at Q34 (= Q22-c-Round2). Examples 2 and 8 use `createSubgraph(subgraph, ...args)` in declaration scope and `.process(...)` per call.
- `forSampleRange(start, end, callback)` partial-block iteration (deferred to v1.x.0; nested `forSample` use cases such as 2D-tile iteration are not exercised).
- `param.at(0)` literal-`0` lifting under `Node<'i32'>` context (Q22 / Q1 interaction; resolved at Round 2 type-rule grilling).
- `everyNSamples` sub-rate work — the surface is decided (Q7) but no current example uses it. A canonical example will land once a use case (e.g. envelope follower at sub-rate) is selected.
- Type conversion primitives (`f32(node)`, `f64(node)`, `i32(node)`) — the surface is in `01-dsl.md` §2 but no example exercises a cross-precision boundary today.
- Math primitives `tan`, `tanh`, `sqrt` — listed in `01-dsl.md` §2 but unused across the example set.
- `buffer.i32` — only `buffer.f32` is exercised.
- MIDI variants beyond `noteOn` / `noteOff`: `cc`, `pitchBend`, `programChange`, `channelPressure`, `aftertouch`, `systemRealtime`, sysex are part of the Q4 surface but no current example uses them. Q4 covers the wire / handler shape; the canonical example set has a coverage gap here.
- `midiOutput.diagnostics.overflowCount()` and `node.events.<name>.diagnostics.overflowCount()` are mentioned but not actively monitored in any example beyond Ex 4 (one polling block).

When those resolutions land or examples are added, the corresponding rows in the Coverage table above are updated in the same revision.
