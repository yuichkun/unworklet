<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import * as monaco from "monaco-editor";
import { audioContext, ensureRunning } from "../audio/AudioEngine";
import { createWasmNode, type WasmUnworkletNode } from "../audio/createWasmNode";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import { UNWORKLET_DTS } from "../codeplayground/monaco-types";
import { evalProcessorSource } from "../codeplayground/runtime";

// Configure Monaco's web workers via Vite's ?worker import. Without this,
// IntelliSense falls back to the main thread and stalls on big files.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

const STARTER = `// Live unworklet playground. Edit the code, hit Run, hear the result.
//
// This processor takes a stereo input, applies a 2× soft-clip distortion,
// then a per-channel one-pole low-pass with a tunable cutoff knob.
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  add,
  sub,
  mul,
  tanh,
  flushDenormals,
} from "@unworklet/core";

export const myProcessor = defineProcessor((ctx) => {
  const main = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const drive = param({ name: "drive", default: 2.0, min: 0.5, max: 8.0, automationRate: "k-rate" });
  const cutoff = param({ name: "cutoff", default: 0.3, min: 0.001, max: 0.999, automationRate: "k-rate" });

  const lpL = state.f32(0, { name: "lpL" });
  const lpR = state.f32(0, { name: "lpR" });

  return {
    process: () => {
      const k = cutoff.at(0);
      const d = drive.at(0);
      forSample((i) => {
        const dryL = main.left.at(i);
        const dryR = main.right.at(i);
        const sat = (x) => tanh(mul(x, d));
        const yL = flushDenormals(add(lpL.load(), mul(k, sub(sat(dryL), lpL.load()))));
        const yR = flushDenormals(add(lpR.load(), mul(k, sub(sat(dryR), lpR.load()))));
        lpL.store(yL);
        lpR.store(yR);
        out.left.set(i,  yL);
        out.right.set(i, yR);
      });
    },
  };
});
`;

const editorRoot = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

const status = ref<{ kind: "idle" | "running" | "error"; message?: string }>({ kind: "idle" });
const meterPeak = ref(0);
const node = shallowRef<WasmUnworkletNode | null>(null);
const params = ref<Array<{ name: string; min: number; max: number; default: number; current: number }>>([]);
const sourceMode = ref<"mic" | "tone">("tone");

let toneOsc: OscillatorNode | null = null;
let toneOsc2: OscillatorNode | null = null;
let micStream: MediaStreamAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;
let analyserData: Float32Array | null = null;
let rafHandle: number | null = null;

onMounted(() => {
  if (!editorRoot.value) return;
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    noImplicitAny: false,
    strict: false,
    esModuleInterop: true,
    skipLibCheck: true,
    typeRoots: [],
    lib: ["es2022"],
  });
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    UNWORKLET_DTS,
    "file:///node_modules/@unworklet/types.d.ts",
  );
  editor = monaco.editor.create(editorRoot.value, {
    value: STARTER,
    language: "typescript",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    theme: "vs-dark",
    tabSize: 2,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
  });
});

onBeforeUnmount(() => {
  stop();
  if (editor) {
    editor.dispose();
    editor = null;
  }
});

async function run() {
  if (!editor) return;
  await stop();
  const source = editor.getValue();
  const result = evalProcessorSource(source);
  if (!result.ok) {
    status.value = { kind: "error", message: result.error };
    return;
  }
  try {
    await ensureRunning();
    const ctx = audioContext();
    const n = await createWasmNode(ctx, result.processor, result.processorName);
    node.value = n;
    // Build a param control list from the AudioWorkletNode's AudioParams.
    const list: Array<{ name: string; min: number; max: number; default: number; current: number }> = [];
    for (const [name, ap] of Object.entries(n.params)) {
      const p = ap as AudioParam;
      list.push({ name, min: p.minValue, max: p.maxValue, default: p.defaultValue, current: p.value });
    }
    params.value = list;
    // Wire the source.
    const inputName = Object.keys(n.inputs)[0];
    const outputName = Object.keys(n.outputs)[0];
    if (inputName) {
      if (sourceMode.value === "mic") {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micStream = ctx.createMediaStreamSource(stream);
          micStream.connect(n.inputs[inputName].node, 0, n.inputs[inputName].index);
        } catch (err: any) {
          status.value = { kind: "error", message: `mic getUserMedia denied: ${err?.message ?? err}` };
          return;
        }
      } else {
        toneOsc = ctx.createOscillator();
        toneOsc.frequency.value = 220;
        toneOsc.type = "sawtooth";
        const gain = ctx.createGain();
        gain.gain.value = 0.3;
        toneOsc.connect(gain).connect(n.inputs[inputName].node, 0, n.inputs[inputName].index);
        toneOsc.start();
      }
    }
    if (outputName) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyserData = new Float32Array(analyser.fftSize);
      n.outputs[outputName].connect(analyser);
      analyser.connect(ctx.destination);
      const tick = () => {
        if (!analyser || !analyserData) return;
        analyser.getFloatTimeDomainData(analyserData);
        let p = 0;
        for (let i = 0; i < analyserData.length; i++) {
          const v = Math.abs(analyserData[i]!);
          if (v > p) p = v;
        }
        meterPeak.value = p;
        rafHandle = requestAnimationFrame(tick);
      };
      tick();
    }
    status.value = { kind: "running" };
  } catch (err: any) {
    status.value = { kind: "error", message: err?.message ?? String(err) };
  }
}

async function stop() {
  if (rafHandle != null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (toneOsc) {
    try { toneOsc.stop(); toneOsc.disconnect(); } catch {}
    toneOsc = null;
  }
  if (toneOsc2) {
    try { toneOsc2.stop(); toneOsc2.disconnect(); } catch {}
    toneOsc2 = null;
  }
  if (micStream) {
    try { micStream.disconnect(); } catch {}
    try {
      const tracks = (micStream as any).mediaStream?.getTracks?.() as MediaStreamTrack[] | undefined;
      tracks?.forEach((t) => t.stop());
    } catch {}
    micStream = null;
  }
  if (analyser) {
    try { analyser.disconnect(); } catch {}
    analyser = null;
    analyserData = null;
  }
  if (node.value) {
    node.value.dispose();
    node.value = null;
  }
  params.value = [];
  meterPeak.value = 0;
  status.value = { kind: "idle" };
}

function onParamChange(p: { name: string; current: number }, value: number) {
  p.current = value;
  if (!node.value) return;
  const ap = node.value.params[p.name] as AudioParam | undefined;
  if (ap) ap.value = value;
}
</script>

<template>
  <ShowcaseShell
    title="Code Playground"
    subtitle="Live-WASM unworklet"
    description="Write a defineProcessor body with full IntelliSense, hit Run, and your code is captured → lowered to WASM → instantiated as a real AudioWorklet — all in the browser. Edit, compile, hear the result."
  >
    <div class="cp-toolbar">
      <button class="primary" @click="run">▶ Run</button>
      <button class="secondary" @click="stop" :disabled="status.kind !== 'running'">■ Stop</button>
      <select v-model="sourceMode" :disabled="status.kind === 'running'">
        <option value="tone">Saw 220Hz (test tone)</option>
        <option value="mic">Microphone</option>
      </select>
      <span class="status" :class="status.kind">
        {{ status.kind === 'running' ? '● Running' : status.kind === 'error' ? '● Error' : '○ Idle' }}
      </span>
    </div>
    <div class="cp-grid">
      <div class="editor-pane">
        <div ref="editorRoot" class="editor"></div>
      </div>
      <div class="side">
        <div class="panel meter">
          <h4>Output peak</h4>
          <div class="bar"><div class="fill" :style="{ width: Math.min(100, meterPeak * 100) + '%' }"></div></div>
          <span class="num">{{ meterPeak.toFixed(3) }}</span>
        </div>
        <div class="panel" v-if="params.length">
          <h4>Params</h4>
          <div v-for="p in params" :key="p.name" class="param-row">
            <label>{{ p.name }}</label>
            <input
              type="range"
              :min="p.min" :max="p.max" :step="(p.max - p.min) / 200"
              :value="p.current"
              @input="onParamChange(p, ($event.target as HTMLInputElement).valueAsNumber)"
            />
            <span class="val">{{ p.current.toFixed(3) }}</span>
          </div>
        </div>
        <div class="panel error" v-if="status.kind === 'error'">
          <h4>Error</h4>
          <pre>{{ status.message }}</pre>
        </div>
      </div>
    </div>
  </ShowcaseShell>
</template>

<style scoped>
.cp-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.cp-toolbar select {
  background: var(--bg-2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.status {
  margin-left: auto;
  font-family: "JetBrains Mono", "SF Mono", monospace;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.status.running { color: #00d4aa; }
.status.error { color: #ff5577; }
.status.idle { color: var(--text-dim); }

.cp-grid {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 16px;
  height: 70vh;
  min-height: 520px;
}
.editor-pane {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: #1e1e1e;
}
.editor { width: 100%; height: 100%; }
.side { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }

.meter .bar {
  height: 8px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-top: 6px;
}
.meter .fill {
  height: 100%;
  background: linear-gradient(90deg, #00d4aa, #ffb84d, #ff5577);
  transition: width 0.05s linear;
}
.meter .num {
  display: block;
  margin-top: 4px;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: var(--text-dim);
}

.param-row {
  display: grid;
  grid-template-columns: 80px 1fr 50px;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.param-row label {
  font-size: 11px;
  color: var(--text-dim);
}
.param-row input[type=range] { width: 100%; }
.param-row .val {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  text-align: right;
  color: var(--accent);
}

.error pre {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #ff8899;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
}
</style>
