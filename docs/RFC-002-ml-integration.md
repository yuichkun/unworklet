# RFC-002 — ML integration (ONNX / NAM / DDSP)

A proposal for extending unworklet so that users can work with learned neural-network-based DSP (NAM amp models, DDSP timbre transfer, ONNX-exported audio NNs in general) using the same TypeScript primitives as existing built-ins. The proposal covers two integrated paths: an AOT path that lowers NNs into the AST and bakes them into a fused WASM binary at build time, and a runtime bridge path that runs large NNs on the main thread.

## Status

**Draft** — proposed for v1.x.0 (post v1.0.0 additive). Outside v1.0.0 scope; proposed as an additive extension after v1.0.0 ships. Does not affect the integrity rules of the v1.0.0 spec or canonical examples.

This RFC is in the proposal stage. It has not been ratified; adoption, revision, and rejection are all open paths. If adopted, corresponding Q entries will be added to `decisions-log.md` and each component doc will be updated accordingly.

> **Surface note.** Any references to the old `message<T>` / `midiInput` / `midiOutput` surface should be read as the current **event family** (`event<T>({ from | to: "main" })` + `event.midi`, `decisions-log.md` Q87 / Q88). The current surface is defined in `01-dsl.md`.

## 1. Motivation

unworklet is a framework that AOT-compiles audio DSP written in TypeScript into pure WASM artifacts, with its design finalized for v1.0.0. Meanwhile, the audio software industry has seen neural-network-based DSP reach production-grade expressive power over the past several years:

- **NAM (Neural Amp Modeler)**: A small LSTM-based NN (~30k parameters) that fully reproduces tube amplifiers and cabinets. Thousands of trained models are publicly available from the community.
- **DDSP (Differentiable DSP)**: From Google Research — an architecture where a NN generates control parameters while audio-rate synthesis is handled by classical DSP. Trained models for violin, saxophone, and more are available.
- **RAVE / autoencoder-based timbre transfer**: Converts arbitrary audio to an arbitrary timbre; an ecosystem growing from IRCAM research.
- **ONNX (Open Neural Network Exchange)**: The de facto standard for ML interchange, led by Microsoft and Meta. A universal format for distributing models trained in PyTorch, TensorFlow, or JAX in a portable way. Used daily across audio, vision, NLP, and all ML domains.

Currently, unworklet has no path for incorporating these NNs. Users must set up onnxruntime-web separately on the main thread, then wire up audio buffer round-trips, control parameter passing via messages, and latency management entirely by hand. This contradicts the core principle of unworklet — that the framework eliminates boilerplate.

At the same time, no existing framework in the audio domain provides first-class NN integration:

- Tone.js / Elementary Audio / Web Audio API: no NN integration
- onnxruntime-web: a NN-dedicated runtime with no audio-domain integration
- NAM C++ engine: specific to one model format, with no declarative TS authoring path
- JUCE: general-purpose C++, no NN integration, targets audio plugin formats

In other words, "a framework where declarative TypeScript can integrate audio DSP and NNs within a single processor" is a completely open design space. This is a natural extension of unworklet's AOT compile + pure WASM artifact + type-safety philosophy into the ML domain.

### 1.1 Anticipated user use cases

If the proposal is ratified, unworklet users will be able to build:

- **Neural amp modeling**: pass guitar input through a trained NAM model of a tube amp and cabinet
- **DDSP timbre transfer**: convert a voice into an instrument sound (saxophone, violin, etc.)
- **AI-driven mastering**: analyze an input track's characteristics with a NN, then auto-adjust EQ / compressor / limiter settings
- **Real-time pitch correction**: integrate an ML-based pitch detector like CREPE into a classical Auto-Tune path
- **Adaptive effects**: detect playing context (dynamics, chord, mood) with a NN, then adaptively modulate reverb / delay settings
- **Voice / source separation**: in-thread inference with Demucs / Spleeter (large NNs go through the runtime bridge)
- **LLM-driven synth patches**: natural language prompt → generated unworklet TS code → immediate audition

## 2. Goals / Non-goals

### Goals

- **Declarative integration**: NNs are handled through an API with the same shape as existing primitives (i.e., `ampModel.process(x)` feels the same as calling `tanh(x)`).
- **AOT path for per-sample inference on small-to-medium NNs**: expand trained models into the AST at build time and emit them as fused WASM, eliminating the generic runtime overhead of onnxruntime-web.
- **Runtime bridge path for per-block inference on large NNs**: run onnxruntime-web on the main thread and connect it to the worklet via SAB / `message<T>`. The framework eliminates the boilerplate.
- **Type safety**: reflect NN input/output shapes and numeric types in branded `Node<T>` types so the IDE and TS compiler catch typos and shape mismatches.
- **Preserved portability**: the emitted artifact stays pure WASM, retaining the ability to run in a browser AudioWorklet, Node, a standalone WASM runtime, a native plugin host, or an embedded environment.
- **Non-disruptive extension of the existing spec**: the v1.0.0 core surface (`defineProcessor`, `Node<T>`, `forSample`, etc.) remains unchanged; everything is contained within a separate package and a unplugin extension. No impact on existing user code.

### Non-goals

- **Self-implementing a generic ONNX runtime**: implementing all ~200 operators is out of scope. Only the audio-relevant subset (~20 operators) is implemented; the rest is delegated to onnxruntime-web via the runtime bridge.
- **Training path**: training (PyTorch / TF, etc.) is outside framework scope. unworklet handles inference only; it provides a path for users to import models trained in a separate environment.
- **Audio-rate per-sample inference for large NNs**: running NNs with hundreds of millions of parameters inside the audio thread is out of scope — impossible given latency and CPU constraints. Medium-and-larger NNs use the runtime bridge exclusively.
- **Specific plugin format adapters**: ML model integration wrappers for VST3 / AU / AAX etc. are out of scope (consistent with the existing invariant that host-format adapters are a non-goal).
- **Cloud inference API wrappers**: integration wrappers for cloud inference endpoints like the OpenAI Whisper API are user-land concerns; the framework does not own them.

## 3. Architecture overview

Three new public packages plus extensions to the existing unworklet packages.

```
@unworklet/core          (existing + minor extension)
   ↓ peer dep
@unworklet/ml            (new — NN primitives and runtime bridge base)
   ↓ depends on
@unworklet/onnx          (new — ONNX file parser + lowering)

@unworklet/nam           (new — NAM-specific helpers)
@unworklet/ddsp          (new — DDSP primitives + loader)

@unworklet/unplugin   (existing + ML asset import extension)
```

Responsibilities of each package:

- **`@unworklet/ml`**: exposes NN primitives (`lstm_cell`, `gru_cell`, `dense_layer`, `conv1d`, `attention`, etc.), the runtime bridge base class, and a universal NN compute layer that has no knowledge of individual file formats.
- **`@unworklet/onnx`**: protobuf parser for ONNX files, lowering of operator graphs to `@unworklet/ml` primitive calls, and a quantization / pruning pipeline.
- **`@unworklet/nam`**: a direct reader for NAM `.json` / `.nam` files, a high-level helper that expands the LSTM forward pass into the AST, and a one-liner API that makes it possible to import any of the `.nam` models available from the community.
- **`@unworklet/ddsp`**: DDSP-specific primitives (harmonic additive synth, filtered noise generator, etc.), a trained model loader, and AOT expansion of the control-parameter NN.
- **`@unworklet/unplugin`** (existing, extended): handles `*.onnx` / `*.nam` / `*.ddsp` imports, emits them into WASM at build time, and generates sidecar `.d.ts` files.

### 3.1 Criteria for choosing the AOT path vs. the runtime path

When combining a NN with unworklet, the appropriate path depends on model size and inference rate.

| NN size                       | Inference rate          | Recommended path                               | Example                      |
| ----------------------------- | ----------------------- | ---------------------------------------------- | ---------------------------- |
| Small (~tens of K params)     | per-sample (audio rate) | **AOT** (`@unworklet/onnx` / `@unworklet/nam`) | NAM amp model                |
| Small (~tens of K params)     | per-block (~ms)         | AOT or runtime                                 | DDSP control parameters      |
| Medium (~millions of params)  | per-block               | **runtime bridge**                             | CREPE pitch detector         |
| Medium (~millions of params)  | per-second or slower    | runtime bridge                                 | AI mastering settings        |
| Large (~hundreds of M params) | per-second or slower    | **runtime bridge + WebGPU**                    | RAVE timbre transfer, Demucs |

Whether the framework auto-infers the choice or the user specifies it via a build option is a decision deferred to implementation-time ratification. The proposal is a **hybrid of model file metadata and build options**: the default has the framework auto-decide based on file size and parameter count, with an escape hatch like `loadOnnxModel('./model.onnx', { path: 'aot' })` to force a specific path.

## 4. User-facing API surface

The proposal centers on the code users write. The core point is that NNs compose fully with existing unworklet primitives.

### 4.1 Case A — NAM (neural amp modeler) AOT path

```typescript
import { defineProcessor, audioInput, audioOutput, forSample } from "@unworklet/core";
import { loadNamModel } from "@unworklet/nam";

// bundled at build time; expanded into WASM via AOT
const ampModel = loadNamModel("./marshall-jcm800.nam");

export const ampPlugin = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  return {
    process: () =>
      forSample((i) => {
        const x = input.ch(0).at(i);
        const y = ampModel.process(x); // NN forward pass, inlined into fused WASM
        out.ch(0).at(i).write(y);
      }),
  };
});
```

The user's mental model is: **"a NN is just a `process(input) → output` function."** Calling `ampModel.process(x)` feels the same as calling `tanh(x)`. What happens internally (LSTM forward pass, quantization, SIMD lane expansion) requires no awareness.

The return type of `loadNamModel` is narrowed by type inference to `{ process: (x: Node<'f32'>) => Node<'f32'>; metadata: NamMetadata }` (provided via a sidecar `.d.ts`; see §6).

### 4.2 Case B — DDSP synthesizer (control NN is AOT; audio rate uses classical DSP)

```typescript
import { defineProcessor, audioOutput, param, state, buffer, forSample } from "@unworklet/core";
import { loadDdspModel, harmonicSynth, filteredNoise } from "@unworklet/ddsp";

const violinTimbre = loadDdspModel("./violin-trained.ddsp");

export const violinSynth = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const pitch = param
    .f32({ default: 440, min: 50, max: 1000, automationRate: "a-rate" })
    .named("pitch");
  const loudness = param
    .f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" })
    .named("loudness");

  // state that holds DDSP control parameters (NN outputs)
  const harmAmps = buffer.f32({ size: 64 }).named("harmAmps");
  const noiseSpec = buffer.f32({ size: 32 }).named("noiseSpec");

  return {
    process: () =>
      forSample((i, everyNSamples) => {
        // run the NN forward pass every 10ms to update control parameters
        everyNSamples(480, () => {
          violinTimbre.predict(
            { pitch: pitch.at(i), loudness: loudness.at(i) },
            { harmAmps, noiseSpec },
          );
        });

        // audio-rate synthesis (classical DSP path — does not pass through the NN)
        const harm = harmonicSynth(pitch.at(i), harmAmps);
        const noise = filteredNoise(noiseSpec);
        out.ch(0).at(i).write(harm.add(noise));
      }),
  };
});
```

`violinTimbre.predict(...)` is **expanded into the AST at build time**, so the whole thing is baked into a single fused WASM function. `harmonicSynth` and `filteredNoise` are classical DSP primitives (a combination of existing unworklet primitives and helpers from `@unworklet/ddsp`).

From the user's perspective: **"NN inference and classical DSP coexist inside the same `forSample` loop in the same TS file."**

### 4.3 Case C — General ONNX (runtime bridge path, large NNs)

For medium-and-larger NNs, the path runs onnxruntime-web on the main side.

```typescript
import { defineProcessor, audioInput, audioOutput, buffer, forSample } from "@unworklet/core";

export const styleTransferPlugin = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  // buffers to fill for NN inference and to read results from
  const nnInput = buffer.f32({ size: 4096 }).named("nnInput");
  const nnOutput = buffer.f32({ size: 4096 }).named("nnOutput");

  return {
    process: () =>
      forSample((i) => {
        nnInput.write(i, input.ch(0).at(i));
        out.ch(0).at(i).write(nnOutput.read(i));
      }),
  };
});
```

```typescript
// Main side
import { createNode } from "@unworklet/core";
import { OnnxBridge } from "@unworklet/ml";

const node = await createNode(audioCtx, styleTransferPlugin);

const bridge = await OnnxBridge.create("./style-transfer.onnx", {
  backend: "webgpu",
  inputBufferName: "nnInput",
  outputBufferName: "nnOutput",
  windowSize: 2048,
  hopSize: 1024,
});

bridge.attach(node);
```

`OnnxBridge` abstracts the following on the framework side:

- onnxruntime-web lifecycle (load, warmup, dispose)
- audio buffer round-trips between worklet and main (via SAB / postMessage, through the existing unworklet messaging layer)
- overlap-add synthesis (continuity across window boundaries)
- inference completion signaling
- switching between WebGPU / WASM backends

The user only needs to **create the bridge and call `.attach()`** to integrate a large NN.

## 5. AOT path internal architecture

What `loadOnnxModel('./model.onnx')` does at build time.

### 5.1 Step 1 — Parse the ONNX file

ONNX is serialized in Protocol Buffers format, which can be decoded using the existing OSS package `onnx-proto`.

```typescript
// inside @unworklet/onnx
function parseOnnxFile(filePath: string): OnnxModel {
  const buffer = fs.readFileSync(filePath);
  const model = onnx.ModelProto.decode(buffer);
  return {
    graph: model.graph,
    initializers: model.graph.initializer, // trained weights
    inputs: model.graph.input,
    outputs: model.graph.output,
  };
}
```

### 5.2 Step 2 — Operator lowering table

A table that lowers each ONNX operator to unworklet primitives. The operator set implemented in the initial v1.x.0 release (~20 operators):

```typescript
const operatorLowerings = {
  Add: (inputs) => add(inputs[0], inputs[1]),
  Sub: (inputs) => sub(inputs[0], inputs[1]),
  Mul: (inputs) => mul(inputs[0], inputs[1]),
  Div: (inputs) => div(inputs[0], inputs[1]),
  Tanh: (inputs) => tanh(inputs[0]),
  Sigmoid: (inputs) => sigmoid(inputs[0]),
  Relu: (inputs) => max(inputs[0], 0),
  MatMul: lowerMatMul,
  Gemm: lowerGemm, // general matrix multiply with bias
  Conv: lowerConv1d, // 1D conv (for audio)
  LSTM: lowerLstmCell,
  GRU: lowerGruCell,
  BatchNormalization: lowerBatchNorm, // fixed affine transform at inference time
  Softmax: lowerSoftmax,
  Slice: lowerSlice,
  Concat: lowerConcat,
  Reshape: lowerReshape,
  Transpose: lowerTranspose,
  Identity: (inputs) => inputs[0],
  Constant: lowerConstant,
};
```

This covers the subset needed for the audio domain (LSTM, GRU, Conv1D, dense, activation, element-wise math). SIMD, Attention layers, Transformers, etc. will be added additively in subsequent phases.

### 5.3 Step 3 — Bake weights as WASM constants

ONNX initializers (trained weights) are emitted as `buffer.f32` constant initializers in unworklet. The weights are **embedded directly in the WASM module — no runtime loading required**. Zero startup latency, cache-friendly.

### 5.4 Step 4 — Graph traversal and lowering

```typescript
function lowerOnnxToUnworklet(model: OnnxModel) {
  const valueMap = new Map<string, Node<any>>();
  const weights = lowerInitializers(model);

  for (const [name, buf] of Object.entries(weights)) {
    valueMap.set(name, buf);
  }

  // traverse operators in topological order
  for (const op of topologicalOrder(model.graph.nodes)) {
    const inputs = op.inputs.map((name) => valueMap.get(name));
    const result = operatorLowerings[op.op_type](inputs, op.attributes);
    op.outputs.forEach((name, idx) => {
      valueMap.set(name, Array.isArray(result) ? result[idx] : result);
    });
  }

  return {
    process: (input: Node<"f32">) => {
      // ... same traversal builds the input → output graph
    },
  };
}
```

The result is that an ONNX file is converted into a `.process(input) → output` interface. The unworklet compile pipeline treats this result as an expression inside a `defineProcessor` body.

### 5.5 Step 5 — Quantization / pruning pipeline

```typescript
loadOnnxModel("./model.onnx", {
  quantization: "int8",
  pruning: { threshold: 0.001 },
  fuseOps: true,
  simdWidth: 4,
});
```

Optimizations applied at build time:

- **Quantization**: weights are held as int8 and dequantized at multiply time
- **Pruning**: MAC operations on zero weights are removed from the AST (sparse expansion)
- **fuseOps**: consecutive `mul(a, b).add(c)` expressions are combined into a single fused multiply-add
- **SIMD**: 4-lane parallel expansion (lowering to the `f32x4` primitive)

These optimizations are not fully achievable with the generic interpretation that onnxruntime-web performs at runtime (runtime-side quantization paths exist but do not reach AOT-equivalent results). They are maximized precisely because unworklet AOT-compiles per NN.

### 5.6 Step 6 — Fusion of the DSP and NN paths

The structural advantage of the AOT path is that the NN forward pass and the `forSample` loop **are baked into the same fused WASM function**. "Pass the NN output directly into a filter" or "feed a filter output into the NN" compose with zero overhead. This is structurally impossible with runtime inference, where the NN is one module and DSP is another, with a memory copy between them.

## 6. Type safety

For each ML asset (ONNX / NAM / DDSP), a sidecar `.d.ts` is generated at build time. The unplugin is responsible for this.

For example, importing `marshall.nam` causes `marshall.nam.d.ts` to be generated at build time:

```typescript
// auto-generated: marshall.nam.d.ts
declare module "./marshall.nam" {
  import type { Node } from "@unworklet/core";
  const model: {
    process: (input: Node<"f32">) => Node<"f32">;
    metadata: {
      readonly sampleRate: 48000;
      readonly modelType: "NAM";
      readonly parameterCount: 32768;
      readonly authorName: string;
      readonly ampDescription: string;
    };
  };
  export default model;
}
```

This gives the IDE and TS compiler the ability to catch errors at compile time:

```typescript
import ampModel from "./marshall.nam";
ampModel.process("hello"); // TS error (string is not Node<'f32'>)
ampModel.process(input.ch(0).at(i)); // OK
ampModel.metadata.sampleRate; // type = 48000 (literal type)
```

Stereo vs. mono, input channel count, output count — all are expressed at the type level. unworklet's existing type safety extends consistently into the NN layer.

## 7. Build pipeline integration (unplugin extension)

`@unworklet/unplugin` is extended to handle special ML asset imports.

```typescript
// vite.config.ts
import { unworklet } from "@unworklet/unplugin";

export default {
  plugins: [
    unworklet({
      ml: {
        onnxOptimize: { quantization: "int8" },
        namPath: "./nam-models/",
      },
    }),
  ],
};
```

Build pipeline:

```
User code (TS)
  ↓
@unworklet/unplugin
  - detects *.onnx imports → parses with @unworklet/onnx → expands to AST → quantizes
  - detects *.nam imports  → parses with @unworklet/nam  → expands to AST
  - detects *.ddsp imports → parses with @unworklet/ddsp → expands to AST
  - merges with the rest of the defineProcessor body and passes to unworklet's compile()
  ↓
@unworklet/core compile()
  ↓
WASM emit via binaryen
  ↓
.wasm artifact (a single binary with NN and DSP fused)
  ↓
sidecar .d.ts also generated (for type inference)
  ↓
deployed at runtime (browser AudioWorklet / Node / etc.)
```

## 8. Runtime bridge path internals

The path for running medium-to-large NNs on the main side. The `OnnxBridge` class abstracts the boilerplate.

```typescript
// @unworklet/ml/runtime-bridge.ts
import * as ort from "onnxruntime-web";

export class OnnxBridge {
  static async create(onnxPath: string, opts: OnnxBridgeOptions): Promise<OnnxBridge> {
    const session = await ort.InferenceSession.create(onnxPath, {
      executionProviders: [opts.backend === "webgpu" ? "webgpu" : "wasm"],
    });
    // warmup run, model shape inspection, etc.
    return new OnnxBridge(session, opts);
  }

  attach(node: UnworkletNode) {
    // subscribe to the unworklet node's buffer.publish to receive NN input
    node.buffer[this.opts.inputBufferName].subscribe(async (inputData) => {
      const inputTensor = new ort.Tensor("float32", inputData, this.inputShape);
      const results = await this.session.run({ [this.inputName]: inputTensor });
      const outputData = results[this.outputName].data as Float32Array;
      // send the result back to the unworklet node's buffer
      node.messages.nnResultArrived(outputData);
    });
  }

  dispose() {
    /* release session */
  }
}
```

The framework handles:

- onnxruntime-web load / instantiate / warmup
- switching between WebGPU / WASM backends
- audio buffer round-trips via SAB (through the existing unworklet messaging layer)
- overlap-add synthesis across window boundaries
- inference completion signal handling
- model lifecycle (dispose, reload)

The user completes integration with **`OnnxBridge.create(...)` + `.attach(node)` — two lines**.

## 9. DevTools integration

One **ML inspector panel** is added to unworklet's existing 8 DevTools panels (see `07-unplugin.md` §6.1). No changes to the existing v1.0.0 panels.

What the ML inspector panel visualizes:

- **Operator graph viewer**: visualizes the ONNX operator graph as a node-link diagram, showing weight shapes, quantization status, and inference cost per layer
- **Activation monitor**: real-time monitoring of output amplitude and spectrum for each layer — making the internals of the NN visible
- **Inference profiler**: measures per-block / per-sample NN computation time at P50 / P95 / P99 (consistent with the existing live latency monitor)
- **Quantization error**: real-time comparison of fp32 vs. int8 output differences

This is the framework's answer to the DX problem of NNs being a black box. It extends the existing unworklet error UX investment (stable error IDs, Rust-style templates, DevTools panels) into the NN domain.

## 10. Implementation phases

This cannot all be built at once. A phased rollout:

### Phase 1 — NAM (~2 months)

- New `@unworklet/nam` package
- Dedicated loader for NAM `.json` / `.nam` files
- AST expansion of the LSTM forward pass (directly from the NAM-specific format, not via ONNX)
- Add `*.nam` import handling to the unplugin
- Canonical example: a "NAM amp model + simple cabinet IR" plugin

This alone establishes **"a guitar amp written in TypeScript that sounds like a tube Marshall stack."** The community signal potential is strong.

### Phase 2 — DDSP (~2 months)

- New `@unworklet/ddsp` package
- AST expansion of the DDSP control-parameter MLP
- `harmonicSynth` and `filteredNoise` DSP primitives
- A loader that reads Google's publicly available trained models (violin, saxophone, etc.) directly
- Canonical example: a "your singing voice → saxophone" voice morphing demo

### Phase 3 — General ONNX AOT (~4 months)

- New `@unworklet/onnx` package
- ONNX protobuf parser
- Lowering for ~20 operators (§5.2)
- Quantization / pruning pipeline
- `*.onnx` import handling in the unplugin

This makes it possible to load audio models exported to ONNX from Hugging Face broadly.

### Phase 4 — Runtime bridge (~2 months)

- `@unworklet/ml/runtime-bridge`
- Wrapping of onnxruntime-web
- WebGPU backend support
- Integration of audio buffer round-trips via SAB
- Overlap-add synthesis

This makes medium-to-large NNs like RAVE, Demucs, Whisper, and CREPE usable through unworklet.

### Phase 5 — DevTools integration (~2 months)

- ML inspector panel
- Operator graph viewer
- Activation monitor
- Inference profiler

### Total effort estimate

Full ML integration complete in 12 months. However, at the end of Phase 1 the community can be shown **"NAM running inside unworklet"**, and the resulting interest can validate the investment decision for subsequent phases.

## 11. Open questions

Design axes to confirm before ratification:

1. **AOT vs. runtime path decision logic**: should the framework auto-decide, should the user specify via a build option, or should it be a hybrid?
2. **ML asset versioning**: cache invalidation when a NAM model is updated, schema hash integration, compatibility with existing snapshots.
3. **Quantization fallback**: build-time warning and fallback rules when int8 quantization causes audible quality degradation.
4. **WebGPU backend requirements**: browser support when using WebGPU in the runtime bridge (e.g., Safari), and the fallback path.
5. **Using onnxruntime-web inside the AudioWorklet**: the possibility of running the ONNX runtime directly inside the audio thread (structurally difficult today but may become feasible as WASM threads evolve).
6. **Scope of training path integration**: how far a future vite plugin could automate ONNX export from PyTorch / TF.
7. **Custom operator addition path**: the surface through which users can add custom operators (i.e., custom layers not present in ONNX).
8. **ML inspector panel data channel**: alignment with the analysis JSON from existing DevTools panels (e.g., `dist/<processor>.graph.json`).

## 12. Alternatives considered

### A. Users interact with onnxruntime-web directly from user-land

The framework provides nothing; users set up onnxruntime-web on the main thread entirely by themselves. The path where the framework does not eliminate boilerplate.

**Rejected because**: it contradicts unworklet's core (eliminating boilerplate). Audio buffer round-trips, overlap-add, and message channel design all become the user's responsibility, lowering the value of the audio framework. The structural advantage of the AOT path is also lost.

### B. Delegate NN integration to a C++ engine (e.g., JUCE) rather than including it in the framework

Treat NN integration as a non-goal and let users write NN plugins separately in JUCE etc.

**Rejected because**: it breaks unworklet's **TypeScript-native + cross-platform** philosophy. The web experience is degraded and the reach for plugin development narrows.

### C. Self-implement a fully generic ONNX runtime

Implement all ~200 operators in-house for a completely portable implementation with no dependency on onnxruntime-web.

**Rejected because**: the implementation effort is prohibitive (Microsoft built this with dozens of person-months of effort), the maintenance burden is large, and the audio-domain subset (~20 operators) covers 80% of use cases, making the ROI poor. The practical approach is to delegate medium-to-large NNs to onnxruntime-web while owning the audio-specific subset via AOT.

### D. Integrate the training path into the framework

Add PyTorch-equivalent autograd to unworklet and provide the full ML stack — training through inference — as the framework.

**Rejected because**: the scope expansion is excessive. Training is already a well-established separate ecosystem (Python + GPU + large datasets), and there is no value in entering it as a latecomer. unworklet **focuses on inference (production inference)**; training is received as an ONNX export from a separate environment.

## 13. References

- ONNX specification: https://onnx.ai
- ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/
- NAM (Neural Amp Modeler): https://github.com/sdatkinson/neural-amp-modeler
- NAM model community: https://www.tone3000.com
- DDSP (Differentiable Digital Signal Processing): Google Magenta team 2020 ICLR paper
- RAVE (Realtime Audio Variational autoEncoder): Antoine Caillon, IRCAM 2021
- CREPE pitch detector: https://github.com/marl/crepe
- Demucs source separation: https://github.com/facebookresearch/demucs
- binaryen (WebAssembly toolkit): https://github.com/WebAssembly/binaryen

## 14. Relationship to the v1.0.0 spec

This RFC is positioned as an additive extension after v1.0.0 ships, and does not change any invariant parts of the v1.0.0 spec:

- `defineProcessor` / `defineSubgraph` / `forSample` signatures remain unchanged
- Existing primitives (`add`, `mul`, `tanh`, ...) are unchanged
- Existing declarations (`state`, `buffer`, `param`, `audioInput`, `audioOutput`, `event`, `message`, `midiInput`, `midiOutput`) are unchanged
- Existing messaging (`SAB Atomics ringbuffer`, `state.publish` rate-gated copy) is unchanged
- The existing unplugin `*.ts` build pipeline is unchanged
- The shapes of existing canonical examples are unchanged

All new additions are self-contained in separate packages and additional import handling in the unplugin, with zero impact on existing user code. This is consistent with the forward-compatibility invariant in the v1.0.0 AGENTS.md "Implementation invariant"; if the RFC is ratified, no retraction of v1.0.0 commits is required.

## 15. Adoption / revision / rejection path

This RFC is in the draft stage. The review process:

1. **Stakeholder review**: collect feedback from the perspective of the framework owner, audio DSP practitioners, and TypeScript engineers
2. **Prototype validation**: run a minimal proof of concept for Phase 1 (NAM) to confirm the feasibility of the proposed architecture
3. **Canonical example consistency check**: verify that the existing `12-canonical-examples.md` does not conflict with the proposed surface (per the AGENTS.md HARD CONTRACT)
4. **Q entry addition to `decisions-log.md`**: if adopted, migrate the major design decisions (AOT vs. runtime path selection criteria, operator subset, quantization defaults, etc.) into the decisions-log
5. **Reflection in each component doc**: after adoption, add the relevant sections to `01-dsl.md` / `02-messaging.md` / `07-unplugin.md`

Even after ratification, if design changes arise during implementation, this RFC itself will be updated to preserve a record of the evolution (maintaining the same audit trail as the existing unworklet decisions-log).
