# 08 — Deployment

How users ship unworklet processors in real applications: bundler integration, browser support, and degradation paths when the runtime environment is constrained.

## Status

skeleton

## 1. Bundler integration

<!-- Q24 — which bundlers ship a first-party plugin (Vite first?), generic ESM strategy
     for the rest. .wasm asset resolution, Worklet module URL via
     `new URL(..., import.meta.url)` or equivalent. Lands here. -->

## 2. Browser compatibility matrix

unworklet normalizes cross-browser variance at the **WASM emission boundary** (`00-foundations.md` §3). The quirks below split into two groups: those unworklet absorbs (A1–A7, consumer-invisible) and those that stay under consumer control (B1–B3, supported via unworklet APIs at the crossing point). Authoritative rationale and rejected alternatives: `decisions-log.md` Q11.

### A. Inside the boundary (unworklet absorbs)

#### A1. Render quantum size 128

WASM is built with `SAMPLES_PER_BLOCK = 128` as a compile-time constant. The worklet entry checks `outputs[0][0].length === 128` once per quantum; a mismatch produces silence + an error event on the main side (see `04-worklet-runtime.md` §3). User code refers to the block length via the imported `SAMPLES_PER_BLOCK` constant rather than a literal.

#### A2. Channel count

`audioInput({ channels: N, name })` / `audioOutput({ channels: N, name })` are baked into the WASM module per declared channel count. Upstream sources connected with a different channel count are normalized by Web Audio's standard up-mix / down-mix rules before the worklet sees them (`04-worklet-runtime.md` §4). `createNode` does not accept main-side overrides for the I/O channel layout.

#### A3. `parameters[name]` array length (0 / 1 / 128)

The worklet's per-block marshalling normalizes the three AudioParam array lengths (length 1 = k-rate or unchanged a-rate, length 128 = changing a-rate, length 0 = unconnected) to a uniform per-sample / per-block API (`param.at(i)` / `param.at(0)`). Length-1 values broadcast to the full block; length-0 values use the param's declared default. User code never observes the length variance.

#### A4. Subnormal flush-to-zero

`state.f32 / state.f64 .store(v)` is compiled with a subnormal guard (`|v| < 1e-30 → 0`), preventing CPU spikes from IIR feedback paths approaching zero. No opt-out in v1.0.0 (`decisions-log.md` Q21).

#### A5. `SharedArrayBuffer` availability

The runtime detects whether `SharedArrayBuffer` is constructible and `crossOriginIsolated` is true, then selects transport accordingly: SAB + Atomics when available, pre-allocated `postMessage` buffers at render-quantum granularity otherwise. The messaging surface (`node.messages.*`, `node.events.*`, MIDI) is byte-identical in both modes; only main-side observation latency differs. Consumers who care can observe the mode via `node.onError` (event code `sab-unavailable`). Full transport details in `02-messaging.md` and `decisions-log.md` Q27.

#### A6. MIDI ringbuffer overflow

Audio-side ringbuffer full → drop-and-report. The audio thread never throws. Drop count is observable from the main side via `node.midi.<name>.diagnostics.overflowCount()` (`11-midi.md` §4 + `decisions-log.md` Q4-c).

#### A7. MIDI clock interpretation

MIDI clock messages (`0xF8` timing clock, `0xFA` start, `0xFB` continue, `0xFC` stop) are delivered as ordinary `systemRealtime` events. unworklet does not interpret tempo, beat position, or play state; transport interpretation lives in consumer code or third-party packages (`11-midi.md` §5 + `decisions-log.md` Q4-d).

### B. Outside the boundary (consumer-owned, unworklet supports the crossing)

#### B1. Web MIDI device permission / hotplug / port enumeration

Consumers call `navigator.requestMIDIAccess(...)` to obtain `MIDIInput` / `MIDIOutput` handles. Permission UI, sysex permission flow, hotplug events, port name format, and 0-based vs 1-based channel display in device UIs are browser-determined; unworklet does not intervene. The handle is passed into unworklet via `node.midi.<name>.connectFromWebMIDI(port)`; from that point inward, MIDI is normalized into the unified `MidiEvent` shape (`11-midi.md` §2). Permission denial, port disconnection, and reconnection are handled in consumer code:

```typescript
const midiAccess = await navigator.requestMIDIAccess({ sysex: true });
const input = [...midiAccess.inputs.values()][0];
node.midi.midiIn.connectFromWebMIDI(input);

midiAccess.onstatechange = (e) => {
  if (e.port.type === 'input' && e.port.state === 'connected') {
    node.midi.midiIn.connectFromWebMIDI(e.port);
  }
};
```

#### B2. AudioContext lifecycle / sampleRate

Consumers construct `new AudioContext(options)`. `latencyHint`, sample rate (host-determined: 44.1 / 48 / 96 kHz), and `audioCtx.resume()` calls (browser auto-play policy) live in consumer code. The context is passed into `createNode(audioCtx, MyProcessor)`; inside the worklet, the rate is exposed as `ctx.sampleRate` (compile-time constant per processor instance):

```typescript
const audioCtx = new AudioContext({ latencyHint: 'interactive' });
const node    = await createNode(audioCtx, MyProcessor);
audioCtx.resume();
```

#### B3. COOP / COEP HTTP headers

Cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`) is a deployment-time concern handled by the consumer's hosting platform. unworklet only detects the runtime result to select the messaging transport (see A5). Missing headers do not break the application — they only force the `postMessage` fallback and add main-side observation latency. See §3 for the graceful-degradation details.

### Per-browser validation

`Chromium × Firefox × Safari` × `{cross-origin isolated, not isolated}` is the validation matrix unworklet runs for every release. Quirks that fall **inside the boundary** are absorbed in a patch release if a browser update introduces new variance. Quirks that fall **outside the boundary** are documented in this section; consumer code is expected to handle them via the standard web platform APIs.

## 3. SharedArrayBuffer graceful degradation

<!-- - With SAB (cross-origin isolated): lock-free ring buffers, typed bulk transfers.
     - Without SAB: postMessage with structured clone, pre-allocated transfer regions.
     - Detection at runtime, mode reported via UnworkletNode.onError diagnostic.
     - SAB is a performance optimization only — never a correctness requirement. -->

## 4. WASM binary distribution

<!-- Compiled WASM ships with the processor bundle. Forward-compatible across browser
     versions as long as the WASM spec level is supported. The runtime client is
     pinned to the version that built the WASM. -->
