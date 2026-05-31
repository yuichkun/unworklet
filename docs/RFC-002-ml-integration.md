# RFC-002 — ML integration (ONNX / NAM / DDSP)

unworklet user が learned neural-network ベース の DSP (= NAM amp model、 DDSP timbre transfer、 ONNX-exported audio NN 全般) を、 既存 primitive と同じ感覚で TS で書ける framework 拡張の提案。 build 時 に NN を AST に lower し て fused WASM に焼く AOT path と、 大規模 NN を main thread で動かす runtime bridge path の 2 つ を 統 合 的 に support する。

## Status

**Draft** — proposed for v1.x.0 (post v1.0.0 additive)。 v1.0.0 scope 外、 v1.0.0 ship 後 の additive 拡張 path として 提案。 v1.0.0 spec / canonical examples の integrity rule に は 影 響 し な い。

本 RFC は提案 段階。 ratify 前 で あり、 採 用 / 修 正 / 却 下 い ず れ の path も 開 い て い る。 採 用 さ れ た 場 合 は decisions-log.md に 対 応 Q entry を 追 加 し て 各 component doc に 反 映 さ れ る。

## 1. Motivation

unworklet は TypeScript で書い た audio DSP を pure WASM artifact として AOT compile する framework と し て v1.0.0 で 設 計 が 確 定 し て い る。 一 方、 audio software 業 界 で は 過 去 数 年、 neural-network ベ ー ス の DSP が production-grade の 表 現 力 を 獲 得 し て い る:

- **NAM (Neural Amp Modeler)**: LSTM ベース の 小規模 NN (~30k parameter) で 真空管アンプ + cabinet を完全再現。 community で 数千 の 学習済み model が 公 開 さ れ て い る。
- **DDSP (Differentiable DSP)**: Google Research 発、 NN が control parameter を 生成し、 audio rate は 古典 DSP で 合成する architecture。 violin / saxophone / 等 の 学習済み model が 利用可能。
- **RAVE / autoencoder-based timbre transfer**: 任意 の 音 を 任 意 の timbre に 変換、 IRCAM の 研究 成果 を base に エ コ シ ス テ ム 拡 大 中。
- **ONNX (Open Neural Network Exchange)**: Microsoft + Meta 主導、 ML interchange の de facto standard。 PyTorch / TensorFlow / JAX で 学 習 し た model を portable に 配布 す る universal format。 audio / vision / NLP / 全 ML domain で daily 使用。

現状 の unworklet で は、 こ れ ら NN を 取 り 込 む path が 不在。 user は ONNX runtime web を main thread で 別途 setup し、 boilerplate な audio buffer 往復、 message 経 由 の control parameter 渡し、 latency 管理、 を 全 て 自分で 組む 必要 が ある。 こ れ は unworklet の 核 心 (= boilerplate を framework が 消す) と 矛 盾 す る 状態。

一 方、 NN を first-class で 統 合 する framework は audio domain で は 現存 し ない:

- Tone.js / Elementary Audio / Web Audio API: NN 統合 ナ シ
- onnxruntime-web: NN 専用 runtime、 audio domain 統合 ナ シ
- NAM C++ engine: 特定 model 形式 専用、 declarative TS から の 書 き 方 ナ シ
- JUCE: C++ 一 般、 NN 統合 ナ シ、 audio plugin format 用

つ ま り 「declarative TS で audio DSP と NN を 1 つ の processor 内 に 統合 で き る framework」 は 完全 に 空 い て い る 設 計 領 域。 unworklet の AOT compile + pure WASM artifact + 型 安全 の 哲学 を ML domain に 拡 張 す る natural extension と し て 位置 す る。

### 1.1 想 定 さ れ る user use case

提 案 が ratify さ れ た 場 合、 unworklet user が 書 け る よ う に な る も の:

- **Neural amp modeling**: ギター入力 を 真空管アンプ + cabinet の 学習済み NAM model に 通す
- **DDSP timbre transfer**: 自分 の 声 を 楽器 音 (= サックス、 violin、 等) に 変換
- **AI-driven mastering**: 入力 楽 曲 の 特徴 を NN で 分析、 EQ / compressor / limiter の settings を 自動調整
- **Real-time pitch correction**: CREPE 等 の ML 系 pitch detector を 古典 Auto-Tune path に 取 り 込 む
- **Adaptive effects**: 演奏 状況 (= 強弱、 chord、 mood) を NN で 検出、 reverb / delay の 設定 を adaptive に 変調
- **Voice / source separation**: Demucs / Spleeter の audio thread 内 inference (= 重 い NN は runtime bridge 経 由)
- **LLM-driven synth patches**: 自然 言 語 prompt → 生成 さ れ た unworklet TS code → 即 試聴

## 2. Goals / Non-goals

### Goals

- **Declarative integration**: NN を 既 存 primitive と 同 じ shape の API で 扱 え る (= `ampModel.process(x)` が `tanh(x)` と 同 じ 感 覚 で 呼 べ る)。
- **AOT path で 小 〜 中規模 NN を per-sample 推論**: 学 習 済 み model を build 時 に AST 展開、 fused WASM と し て emit。 onnxruntime-web の generic runtime overhead を 排 除。
- **Runtime bridge path で 大規模 NN を per-block 推論**: main thread で onnxruntime-web を 動 か し、 SAB / message<T> で worklet と 連携。 boilerplate は framework が 消 す。
- **型 安全**: NN 入出力 の shape / 数値 type を branded `Node<T>` 系 に 反映、 IDE で typo / shape mismatch を catch。
- **Portability の 維 持**: emit さ れ る artifact は pure WASM の ま ま、 browser AudioWorklet / Node / standalone WASM runtime / native plugin / embedded で 動 く 性 質 を 失 わ な い。
- **既存 spec の non-disruptive 拡張**: v1.0.0 core surface (`defineProcessor`、 `Node<T>`、 `forSample` 等) を 変 え ず、 別 package と vite-plugin 拡張 で 完結。 既存 user の code に 影響 ナ シ。

### Non-goals

- **Generic ONNX runtime の 自前 実 装**: ~200 operator 全 implement は scope 外。 audio で 使う subset (~20 operator) の み 実 装、 残 り は runtime bridge path で onnxruntime-web に 委 譲。
- **NN 学習 path**: 学習 (= PyTorch / TF 等) は framework scope 外。 unworklet は 推論 専 用、 user が 別 環境 で 学習 し た model を 取 り 込 む path を 提 供。
- **大規模 NN の audio-rate per-sample 推論**: 数億 parameter ク ラ ス の NN を audio thread 内 で 動 か す 試 み は scope 外。 latency / CPU 制約 上 不可能。 中規模 以 上 は runtime bridge 一 択。
- **Specific plugin format adapter**: VST3 / AU / AAX 等 へ の ML model 統合 ラッパー は scope 外 (= host-format adapter 非 goal の 既存 invariant と zip)。
- **Cloud-based inference API ラッパー**: OpenAI Whisper API 等 の ク ラ ウ ド 推論 へ の 統合 wrapper は user-land、 framework が 担 当 し な い。

## 3. Architecture overview

3 つ の 新規 公開 package + 既存 unworklet の 拡張 で 構 成。

```
@unworklet/core          (既存 + minor 拡張)
   ↓ peer dep
@unworklet/ml            (新規 — NN primitive と runtime bridge base)
   ↓ depends on
@unworklet/onnx          (新規 — ONNX file parser + lower)

@unworklet/nam           (新規 — NAM-specific helper)
@unworklet/ddsp          (新規 — DDSP primitive + loader)

@unworklet/vite-plugin   (既存 + ML asset import 拡張)
```

各 package の 責 務:

- **`@unworklet/ml`**: NN primitive (`lstm_cell`、 `gru_cell`、 `dense_layer`、 `conv1d`、 `attention` 等) の 公開、 runtime bridge の base class、 個別 file format は 知 ら な い universal な NN compute layer。
- **`@unworklet/onnx`**: ONNX file の protobuf parser、 operator graph → `@unworklet/ml` primitive 呼 び 出 し へ の lowering、 量子化 / プルーニング pipeline。
- **`@unworklet/nam`**: NAM の `.json` / `.nam` file の 直接 reader、 LSTM ベース forward pass を AST に 展開 す る 高 level helper。 community で 大量 に 公 開 さ れ て い る .nam model を 即 import 可能 に す る 1 行 API。
- **`@unworklet/ddsp`**: DDSP-specific primitive (harmonic additive synth、 filtered noise generator、 等)、 学習済み model loader、 control parameter NN の AOT 展開。
- **`@unworklet/vite-plugin`** (既存 拡張): `*.onnx` / `*.nam` / `*.ddsp` import の handle、 build 時 に WASM 内 emit、 sidecar `.d.ts` 生成。

### 3.1 AOT path と runtime path の 選 択 基 準

NN を unworklet と 組 み 合 わ せ る 際、 model 規 模 と 推論 rate で path が 分 か れ る。

| NN 規模             | 推論 rate               | 推奨 path                                      | 代表例                        |
| ------------------- | ----------------------- | ---------------------------------------------- | ----------------------------- |
| 小 (~ 数万 param)   | per-sample (audio rate) | **AOT** (`@unworklet/onnx` / `@unworklet/nam`) | NAM amp model                 |
| 小 (~ 数万 param)   | per-block (~ ms)        | AOT or runtime                                 | DDSP control parameter        |
| 中 (~ 数百万 param) | per-block               | **runtime bridge**                             | CREPE pitch detector          |
| 中 (~ 数百万 param) | per-second 〜           | runtime bridge                                 | AI mastering settings         |
| 大 (~ 数億 param)   | per-second 〜           | **runtime bridge + WebGPU**                    | RAVE timbre transfer、 Demucs |

判 断 基 準 を framework が 自 動 推 論 す る か、 user が build option で 明示 す る か は 実装 時 ratify。 提案 と し て は **model file の metadata + build option の hybrid**。 デ フ ォ ル ト は file size + parameter 数 か ら framework が auto-decide、 必要 な ら `loadOnnxModel('./model.onnx', { path: 'aot' })` で 強 制。

## 4. User-facing API surface

User が 書 く コード を 中 心 に 提案 を 示 す。 既 存 unworklet primitive と 完全 に 合 成 で き る こ と が 核 心。

### 4.1 Case A — NAM (neural amp modeler) AOT path

```typescript
import { defineProcessor, audioInput, audioOutput, forSample } from "@unworklet/core";
import { loadNamModel } from "@unworklet/nam";

// build 時 に bundle、 AOT で WASM 内 に 展開 さ れ る
const ampModel = loadNamModel("./marshall-jcm800.nam");

export const ampPlugin = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  return {
    process: () =>
      forSample((i) => {
        const x = input.ch(0).at(i);
        const y = ampModel.process(x); // NN forward pass、 fused WASM 内 inline
        out.ch(0).at(i).write(y);
      }),
  };
});
```

User の mental model = 「**NN は 単 な る `process(input) → output` の function**」。 既 存 の `tanh(x)` を 呼 ぶ の と 同 じ 感 覚 で `ampModel.process(x)` が 呼 べ る。 内部 で 何 が 起 こ っ て い る か (= LSTM forward pass、 量子化、 SIMD lane 展開) は 意 識 不要。

`loadNamModel` の 戻 り 値 は 型 推論 で `{ process: (x: Node<'f32'>) => Node<'f32'>; metadata: NamMetadata }` に narrow さ れ る (= sidecar `.d.ts` で 提供、 §6 参 照)。

### 4.2 Case B — DDSP synthesizer (control NN は AOT、 audio rate は 古典 DSP)

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

  // DDSP control parameter (NN 出力) を hold す る state
  const harmAmps = buffer.f32({ size: 64 }).named("harmAmps");
  const noiseSpec = buffer.f32({ size: 32 }).named("noiseSpec");

  return {
    process: () =>
      forSample((i, everyNSamples) => {
        // 10ms ご と に NN forward pass を 走 ら せ て control parameter を update
        everyNSamples(480, () => {
          violinTimbre.predict(
            { pitch: pitch.at(i), loudness: loudness.at(i) },
            { harmAmps, noiseSpec },
          );
        });

        // Audio rate synthesis (= 古典 DSP path、 NN を 通 ら な い)
        const harm = harmonicSynth(pitch.at(i), harmAmps);
        const noise = filteredNoise(noiseSpec);
        out.ch(0).at(i).write(harm.add(noise));
      }),
  };
});
```

`violinTimbre.predict(...)` は **build 時 に AST 展開**、 全 体 が 1 つ の fused WASM 関数 に 焼 か れ る。 `harmonicSynth` と `filteredNoise` は 古典 DSP primitive (= unworklet 既存 primitive と `@unworklet/ddsp` 提供 helper の 組 み 合 わ せ)。

User 視点 で は 「**NN inference と 古典 DSP が 同 じ TS file の 同 じ `forSample` 内 で 混在 す る**」 体験。

### 4.3 Case C — 汎用 ONNX (runtime bridge path、 大規模 NN)

中 規 模 以 上 の NN は main 側 で onnxruntime-web で 動 か す path。

```typescript
import { defineProcessor, audioInput, audioOutput, buffer, forSample } from "@unworklet/core";

export const styleTransferPlugin = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });

  // Buffer in / out (= NN 推論用 に 積 み 込 む / 取 り 出 す)
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
// Main 側
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

`OnnxBridge` が 以下 を framework 側 で 抽 象 化:

- onnxruntime-web の lifecycle (= load、 warmup、 dispose)
- audio buffer の worklet ↔ main 往復 (= SAB / postMessage、 unworklet 既存 messaging layer 経 由)
- overlap-add 合 成 (= window 切替 時 の 連続性 確保)
- 推論 完 了 の signal
- WebGPU / WASM backend 切替

User は **「bridge を 作 っ て attach す る だ け**」 で 大規模 NN が 組 み 込 ま れ る。

## 5. AOT path の internal architecture

`loadOnnxModel('./model.onnx')` が build 時 に 何 を す る か。

### 5.1 Step 1 — ONNX file の parse

ONNX は Protocol Buffers format で serialize さ れ る。 既存 OSS package (= `onnx-proto`) で decode 可能。

```typescript
// @unworklet/onnx 内部
function parseOnnxFile(filePath: string): OnnxModel {
  const buffer = fs.readFileSync(filePath);
  const model = onnx.ModelProto.decode(buffer);
  return {
    graph: model.graph,
    initializers: model.graph.initializer, // 学 習 済 み weights
    inputs: model.graph.input,
    outputs: model.graph.output,
  };
}
```

### 5.2 Step 2 — operator lowering table

各 ONNX operator を unworklet primitive に lower す る table を 持 つ。 v1.x.0 初版 で 実 装 す る operator set (~20 個):

```typescript
const operatorLowerings = {
  Add: (inputs) => add(inputs[0], inputs[1]),
  Sub: (inputs) => sub(inputs[0], inputs[1]),
  Mul: (inputs) => mul(inputs[0], inputs[1]),
  Div: (inputs) => div(inputs[0], inputs[1]),
  Tanh: (inputs) => tanh(inputs[0]),
  Sigmoid: (inputs) => sigmoid(inputs[0]),
  Relu: (inputs) => max(inputs[0], num(0)),
  MatMul: lowerMatMul,
  Gemm: lowerGemm, // general matrix multiply with bias
  Conv: lowerConv1d, // 1D conv (audio 用)
  LSTM: lowerLstmCell,
  GRU: lowerGruCell,
  BatchNormalization: lowerBatchNorm, // 推論 時 は 固定 affine
  Softmax: lowerSoftmax,
  Slice: lowerSlice,
  Concat: lowerConcat,
  Reshape: lowerReshape,
  Transpose: lowerTranspose,
  Identity: (inputs) => inputs[0],
  Constant: lowerConstant,
};
```

audio domain で 必要 な subset (= LSTM、 GRU、 Conv1D、 dense、 activation、 element-wise math) は こ れ で カ バ ー さ れ る。 後 続 phase で SIMD / Attention layer / Transformer 等 を additive に 追加。

### 5.3 Step 3 — weights の WASM constant bake

ONNX initializer (= 学習済み weights) を unworklet の `buffer.f32` constant initializer と し て emit。 weight は **runtime に load 不要、 WASM module 内 に 直接 embed**。 startup latency ゼ ロ、 cache friendly。

### 5.4 Step 4 — graph 走査 + lowering

```typescript
function lowerOnnxToUnworklet(model: OnnxModel) {
  const valueMap = new Map<string, Node<any>>();
  const weights = lowerInitializers(model);

  for (const [name, buf] of Object.entries(weights)) {
    valueMap.set(name, buf);
  }

  // topological order で operator を traverse
  for (const op of topologicalOrder(model.graph.nodes)) {
    const inputs = op.inputs.map((name) => valueMap.get(name));
    const result = operatorLowerings[op.op_type](inputs, op.attributes);
    op.outputs.forEach((name, idx) => {
      valueMap.set(name, Array.isArray(result) ? result[idx] : result);
    });
  }

  return {
    process: (input: Node<"f32">) => {
      // ... 同 じ traversal で input → output graph を 構築
    },
  };
}
```

結果 と し て ONNX file が 「`.process(input) → output` interface に変 換」 さ れ る。 unworklet の compile pipeline は こ の 結果 を `defineProcessor` body 内 の expression と し て 扱 う。

### 5.5 Step 5 — 量子化 / プルーニング pipeline

```typescript
loadOnnxModel("./model.onnx", {
  quantization: "int8",
  pruning: { threshold: 0.001 },
  fuseOps: true,
  simdWidth: 4,
});
```

build 時 に effective な 最適化:

- **量子化**: weight を int8 で hold、 multiply 時 に dequant + multiply
- **プルーニング**: 重 み 0 の MAC 演算 を AST か ら 除外 (sparse 展開)
- **fuseOps**: 連続 す る `mul(a, b).add(c)` を 1 つ の fused multiply-add に
- **SIMD**: 4 lane 並列展開 (= `f32x4` primitive へ の lower)

こ れ ら の 最適化 は ONNX runtime web の generic interpret で は fully 効 か な い (= runtime 段 で 量子化 する path も あ る が AOT 同等 ま で は 出 な い)。 unworklet の per-NN 専用 AOT compile だ か ら こ そ 最 大 化 さ れ る。

### 5.6 Step 6 — DSP path と NN path の fusion

NN forward pass と forSample loop が **同 じ fused WASM 関数 に 焼 か れ る** こ と が AOT path の 構造的 優位。 「NN 出力 を 直接 filter に 通 す」 「filter 出力 を NN 入力 に 渡 す」 が overhead な し で 結合 す る。 こ れ は runtime 推論 で は 構造的 に 不 可能 (= NN は 1 つ の module、 DSP は 別 module、 間 に memory copy が 入 る)。

## 6. Type safety

ONNX / NAM / DDSP の 各 ML asset に 対 し て、 sidecar `.d.ts` を build 時 に generate す る path。 vite-plugin が responsible。

例 え ば `marshall.nam` を import す る と、 build 時 に `marshall.nam.d.ts` が 生 成 さ れ:

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

こ れ で IDE / TS compiler 段 で:

```typescript
import ampModel from "./marshall.nam";
ampModel.process("hello"); // TS error (string は Node<'f32'> じ ゃ な い)
ampModel.process(input.ch(0).at(i)); // OK
ampModel.metadata.sampleRate; // 型 = 48000 (literal type)
```

stereo / mono、 input channel 数、 output 数、 全 て type level で 表 現 さ れ る。 unworklet の 既存 型 安全性 が NN 周 り で も 一貫 す る。

## 7. Build pipeline 統合 (vite-plugin 拡張)

`@unworklet/vite-plugin` を 拡張 し て ML asset の 特殊 import を handle す る。

```typescript
// vite.config.ts
import { unworklet } from "@unworklet/vite-plugin";

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

build pipeline:

```
User code (TS)
  ↓
@unworklet/vite-plugin
  - *.onnx import を 検出 → @unworklet/onnx で parse → AST 展開 → 量子化
  - *.nam import を 検出 → @unworklet/nam で parse → AST 展開
  - *.ddsp import を 検出 → @unworklet/ddsp で parse → AST 展開
  - 残 り の defineProcessor body と 統合 し て unworklet の compile() に 渡 す
  ↓
@unworklet/core の compile()
  ↓
binaryen で WASM emit
  ↓
.wasm artifact (= NN + DSP が fused さ れ た 1 binary)
  ↓
sidecar .d.ts も 生成 (型 推論 用)
  ↓
runtime に deploy (= browser AudioWorklet / Node / 等)
```

## 8. Runtime bridge path の internal

中 〜 大規模 NN を main 側 で 動 か す path。 `OnnxBridge` class が boilerplate を 抽 象 化。

```typescript
// @unworklet/ml/runtime-bridge.ts
import * as ort from "onnxruntime-web";

export class OnnxBridge {
  static async create(onnxPath: string, opts: OnnxBridgeOptions): Promise<OnnxBridge> {
    const session = await ort.InferenceSession.create(onnxPath, {
      executionProviders: [opts.backend === "webgpu" ? "webgpu" : "wasm"],
    });
    // warmup run、 model 形状 inspection、 等
    return new OnnxBridge(session, opts);
  }

  attach(node: UnworkletNode) {
    // unworklet node の buffer.publish を subscribe し て NN input を 取得
    node.buffer[this.opts.inputBufferName].subscribe(async (inputData) => {
      const inputTensor = new ort.Tensor("float32", inputData, this.inputShape);
      const results = await this.session.run({ [this.inputName]: inputTensor });
      const outputData = results[this.outputName].data as Float32Array;
      // 結果 を unworklet node の buffer に 送 り 返 す
      node.messages.nnResultArrived(outputData);
    });
  }

  dispose() {
    /* session 解放 */
  }
}
```

framework が 担 当:

- onnxruntime-web の load / instantiate / warmup
- WebGPU / WASM backend の 切替
- audio buffer の SAB 経由 往復 (= 既存 unworklet messaging layer 経由)
- window 切替 時 の overlap-add 合成
- 推論 完了 の signal handling
- model lifecycle (= dispose、 reload)

User は **`OnnxBridge.create(...)` + `.attach(node)` の 2 行** で 完結。

## 9. DevTools 統合

unworklet の 既 存 8 DevTools panel (= `07-vite-plugin.md` §6.1) に **ML inspector panel** を 1 つ 追加。 v1.0.0 既存 panel に は 変更 ナ シ。

ML inspector panel が visualize す る も の:

- **Operator graph viewer**: ONNX の operator graph を node-link diagram で 可視化、 各 layer の weight shape / quantization status / inference cost を 表 示
- **Activation monitor**: 各 layer の output amplitude / spectrum を realtime monitor、 NN の 中 身 が 「見 え る」
- **Inference profiler**: per-block / per-sample の NN 計算時間 を P50 / P95 / P99 で 計測 (= 既存 Live latency monitor と 整合)
- **Quantization error**: fp32 vs int8 の output 差分 を realtime 比較

こ れ は NN が black box に な り が ち と い う DX 課題 を framework と し て 解決。 既 存 unworklet の error UX 投資 (= stable error ID + Rust-style template + DevTools panel) を NN domain に 拡 張 す る。

## 10. Implementation phases

全 部 を 一 度 に は 作 れ な い。 phased rollout で:

### Phase 1 — NAM (~2 ヶ月)

- `@unworklet/nam` package 新規
- NAM の `.json` / `.nam` 専用 loader
- LSTM forward pass の AST 展開 (= ONNX 経由 な し、 NAM 固有 形式 か ら 直接)
- vite-plugin に `*.nam` import handle 追加
- canonical example と し て 「NAM amp model + simple cabinet IR」 plugin

こ れ だ け で 「**TypeScript で 書 い た guitar amp が 真空管 Marshall stack の 音 で 鳴 る**」 が 成立。 community の signal 力 が 強 い。

### Phase 2 — DDSP (~2 ヶ月)

- `@unworklet/ddsp` package 新規
- DDSP control parameter MLP の AST 展開
- `harmonicSynth`、 `filteredNoise` の DSP primitive
- Google が 公 開 し て い る 学習済 み model (= violin、 saxophone、 等) を そ の ま ま 読 め る loader
- canonical example と し て 「自分 の 歌声 → サックス」 voice morphing demo

### Phase 3 — 汎用 ONNX AOT (~4 ヶ月)

- `@unworklet/onnx` package 新規
- ONNX protobuf parser
- ~20 operator (§5.2) の lowering
- 量子化 / プルーニング pipeline
- vite-plugin の `*.onnx` import handle

こ れ で Hugging Face で ONNX export さ れ た audio model が 広 く 読 め る よ う に な る。

### Phase 4 — runtime bridge (~2 ヶ月)

- `@unworklet/ml/runtime-bridge`
- onnxruntime-web の wrapping
- WebGPU backend サ ポ ー ト
- audio buffer の SAB 経由 往復 統合
- overlap-add 合成

こ れ で RAVE、 Demucs、 Whisper、 CREPE 等 の 中 〜 大規模 NN が unworklet 経由 で 使え る。

### Phase 5 — DevTools 統合 (~2 ヶ月)

- ML inspector panel
- operator graph viewer
- activation monitor
- inference profiler

### 合 計 工 数 感

12 ヶ月 で full ML integration 完成。 ただ し Phase 1 終了 時点 で community に 「**NAM が unworklet で 動 く**」 を 発信 で き る、 そ こ か ら interest が 広 が り 後続 phase の 投資 決断 を 検証 可能。

## 11. Open questions

ratify 前 に 確定 し て お く べ き 設計 軸:

1. **AOT path / runtime path の 判 断 ロ ジ ッ ク**: framework が auto-decide する か、 user が build option で 明示 す る か、 hybrid に す る か。
2. **ML asset の versioning**: NAM model が 更 新 さ れ た 時 の cache invalidation、 schema hash 統合、 既存 snapshot との 互換性。
3. **量子化 fallback**: int8 量子化 で 音質 劣化 が 出 た 場合 の build 時 警 告 / fallback rule。
4. **WebGPU backend の 必須要件**: runtime bridge で WebGPU を 使う 場合 の browser 対応 (= Safari 等)、 fallback path。
5. **AudioWorklet 内 で の onnxruntime-web 利用**: audio thread 内 で 直接 ONNX runtime web を 動 か す 可能性 (= 構 造 的 に 困難 だ が future の WASM thread 進化 で 可能 に な る か も)。
6. **学習 path の 統合**: 将来 的 に PyTorch / TF か ら ONNX export を 自動化 す る vite plugin の 範 囲。
7. **Custom operator の 追加 path**: user が 自前 の operator (= ONNX に な い custom layer) を 追加 す る surface。
8. **ML inspector panel の data channel**: 既存 DevTools panel の analysis JSON (= `dist/<processor>.graph.json` 等) と の 整合。

## 12. Alternatives considered

### A. user-land で onnxruntime-web を 全部 直 接 触 る

framework は 何 も 提 供 せ ず、 user が onnxruntime-web を main thread で 全 て setup す る。 boilerplate を framework が 消 さ な い path。

**却下理由**: unworklet の 核心 (= boilerplate を 消す) と 矛盾。 audio buffer の 往復、 overlap-add、 message channel 設計、 等 が user の 責 任 に な り、 audio framework と し て の value が 下 が る。 ま た AOT path の 構造的 優位 が 取 れ な い。

### B. NN を framework に 入 れ ず C++ engine (= JUCE) に 委 譲

audio framework と し て の NN 統合 を non-goal と し て、 user は JUCE 等 で NN plugin を 別途 書 く。

**却下 理由**: unworklet の **TypeScript native + cross-platform** の 哲学 を 破る。 web で の 体験 が 損 な わ れ る、 plugin 開発 へ の reach が 狭 ま る。

### C. 完全 generic な ONNX runtime を 自前 実 装

~200 operator 全 て を 自分 で 実装、 onnxruntime-web に 依 存 し な い 完全 portable 実装。

**却下 理由**: 工数 過大 (= Microsoft が 数 十 人 月 か け て 作 っ て い る も の)、 maintenance 負担 大、 audio domain の subset (~20 operator) で 80% の use case が cover で き る の で ROI が 悪 い。 中 〜 大規模 NN は onnxruntime-web に 委 譲、 audio-specific subset は AOT で 持 つ、 が 現実 的。

### D. 学習 path も framework に 統合

PyTorch 相当 の autograd を unworklet に 追加 し、 学習 か ら 推論 ま で の full ML stack を framework と し て 提 供。

**却下 理由**: scope 拡大 す ぎ。 学習 は 別 ecosystem (= Python + GPU + 大量 デ ー タ) で 既 に 確立、 そ こ に 後発 で 入 る 価値 ナシ。 unworklet は **推論 (= production inference) に focus**、 学習 は 別 環境 か ら ONNX export で 受 け 取 る。

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

## 14. v1.0.0 spec と の 関 係

本 RFC は v1.0.0 ship 後 の additive 拡張 と し て 位置 づ け、 v1.0.0 spec の 不変 部分 を 変 更 し な い:

- `defineProcessor` / `defineSubgraph` / `forSample` の signature 維 持
- 既存 primitive (`add`, `mul`, `tanh`, ...) 変更 ナ シ
- 既存 declaration (`state`, `buffer`, `param`, `audioInput`, `audioOutput`, `event`, `message`, `midiInput`, `midiOutput`) 変更 ナ シ
- 既存 messaging (`SAB Atomics ringbuffer`, `state.publish` rate-gated copy) 変更 ナ シ
- 既存 vite-plugin の `*.ts` build pipeline 変更 ナ シ
- canonical examples の 既存 シ ェ イ プ 変更 ナ シ

新規 追加 は 全 て 別 package と vite-plugin の 追加 import handle で 完結 し、 既存 user の code に は 一 切 影響 し な い。 こ れ は v1.0.0 の AGENTS.md「Implementation invariant」 の 前 方互 換 invariant と zip し て お り、 RFC が ratify さ れ て も v1.0.0 commit の retract は 不要。

## 15. 採用 / 修正 / 却下 の 道 筋

本 RFC は draft 段階。 review process と し て:

1. **stakeholder review**: framework owner、 audio DSP 経験者、 TypeScript エンジニア の 各 観点 か ら の feedback 収集
2. **prototype 検証**: Phase 1 (NAM) の 最小実証 を 走 ら せ て、 提案 architecture の feasibility を 確認
3. **canonical example 整合性 check**: 既存 `12-canonical-examples.md` が 提案 surface と 衝突 し な い こ と を 検証 (= AGENTS.md HARD CONTRACT)
4. **decisions-log.md へ の Q entry 追加**: 採用 さ れ た 場合、 主要 設計 判断 (= AOT vs runtime path 選択 基準、 operator subset、 量子化 default、 等) を decisions-log に 移行
5. **各 component doc へ の 反映**: 採用 後 は `01-dsl.md` / `02-messaging.md` / `07-vite-plugin.md` の 該当 セクション に 加筆

ratify さ れ た 後 も、 実装 段 階 で 設計 修正 が 出 た 場合 は 本 RFC 自体 を update し て 経過 を 残 す (= 既存 unworklet の decisions-log と 同様 の audit trail を 維持)。
