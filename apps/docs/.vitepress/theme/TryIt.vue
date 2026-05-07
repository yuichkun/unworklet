<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { evalProcessorSource } from "./runtime";
import { UNWORKLET_DTS } from "./monaco-types";
// `@unworklet/worklet` and `monaco-editor` are dynamically imported inside
// onMounted / run so the SSR build doesn't pull binaryen.js into the
// module graph (4MB asm.js blob that breaks the commonjs resolver).
type AnyNode = any;

// Inline `<TryIt code="...">` block: a small Monaco editor + Run/Stop +
// param sliders + meter, embedded in markdown. Boots a real
// AudioWorkletNode against the same WASM compile path the rest of the
// docs talk about.

const props = defineProps<{
  /** Initial source code shown in the editor. */
  code: string;
  /** Editor height (default 240px). Pass "tall" for 360px. */
  size?: "compact" | "tall";
  /** Test signal at the input port: tone (saw), noise, or silent. Default tone. */
  source?: "tone" | "noise" | "silent";
  /** Label shown in the corner; defaults to the topic of the page. */
  label?: string;
}>();

const editorRoot = ref<HTMLElement | null>(null);
const status = ref<{ kind: "idle" | "running" | "error"; message?: string }>({ kind: "idle" });
const meterPeak = ref(0);
const node = shallowRef<AnyNode | null>(null);
const params = ref<Array<{ name: string; min: number; max: number; default: number; current: number }>>([]);
let editor: any = null;
let monaco: any = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let analyserData: Float32Array | null = null;
let toneSrc: OscillatorNode | null = null;
let noiseSrc: AudioBufferSourceNode | null = null;
let rafHandle: number | null = null;

const heightPx = props.size === "tall" ? 360 : 240;

onMounted(async () => {
  if (!editorRoot.value) return;
  try {
    monaco = await import("monaco-editor");
    const EditorWorker = (await import("monaco-editor/esm/vs/editor/editor.worker?worker")).default;
    const TsWorker = (await import("monaco-editor/esm/vs/language/typescript/ts.worker?worker")).default;
    (self as any).MonacoEnvironment = {
      getWorker(_: unknown, label: string) {
        if (label === "typescript" || label === "javascript") return new TsWorker();
        return new EditorWorker();
      },
    };
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
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      UNWORKLET_DTS,
      "file:///node_modules/@unworklet/types.d.ts",
    );
    editor = monaco.editor.create(editorRoot.value, {
      value: props.code,
      language: "typescript",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      theme: "vs-dark",
      tabSize: 2,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      lineNumbers: "off",
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 4,
    });
  } catch (err) {
    console.error("[TryIt] failed to mount monaco:", err);
  }
});

onBeforeUnmount(() => {
  stop();
  if (editor) {
    editor.dispose();
    editor = null;
  }
});

async function ensureCtx(): Promise<AudioContext> {
  if (!audioContext) audioContext = new AudioContext({ sampleRate: 48000 });
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

async function run() {
  if (!editor) return;
  await stop();
  status.value = { kind: "running", message: "compiling..." };
  const source = editor.getValue();
  const result = await evalProcessorSource(source);
  if (!result.ok) {
    status.value = { kind: "error", message: result.error };
    return;
  }
  try {
    const ctx = await ensureCtx();
    const { createWasmNode } = await import("@unworklet/worklet");
    const n = await createWasmNode(ctx, result.processor, result.processorName);
    node.value = n;
    const list: Array<{ name: string; min: number; max: number; default: number; current: number }> = [];
    for (const [name, ap] of Object.entries(n.params)) {
      const p = ap as AudioParam;
      list.push({ name, min: p.minValue, max: p.maxValue, default: p.defaultValue, current: p.value });
    }
    params.value = list;
    const inputName = Object.keys(n.inputs)[0];
    const outputName = Object.keys(n.outputs)[0];
    const sourceMode = props.source ?? "tone";
    if (inputName && sourceMode !== "silent") {
      if (sourceMode === "tone") {
        toneSrc = ctx.createOscillator();
        toneSrc.frequency.value = 220;
        toneSrc.type = "sawtooth";
        const g = ctx.createGain();
        g.gain.value = 0.3;
        toneSrc.connect(g).connect(n.inputs[inputName].node, 0, n.inputs[inputName].index);
        toneSrc.start();
      } else {
        // noise — 1s loop of white noise at 0.3 amplitude
        const buf = ctx.createBuffer(2, 48000, 48000);
        for (let c = 0; c < 2; c++) {
          const ch = buf.getChannelData(c);
          for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.3;
        }
        noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = buf;
        noiseSrc.loop = true;
        noiseSrc.connect(n.inputs[inputName].node, 0, n.inputs[inputName].index);
        noiseSrc.start();
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
  if (toneSrc) {
    try { toneSrc.stop(); toneSrc.disconnect(); } catch {}
    toneSrc = null;
  }
  if (noiseSrc) {
    try { noiseSrc.stop(); noiseSrc.disconnect(); } catch {}
    noiseSrc = null;
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
  <div class="tryit">
    <div class="bar">
      <button class="run" @click="run">▶ Run</button>
      <button class="stop" @click="stop" :disabled="status.kind !== 'running'">■ Stop</button>
      <span class="label">{{ label ?? "live" }}</span>
      <span class="status" :class="status.kind">
        {{ status.kind === 'running' ? '● running' : status.kind === 'error' ? '● error' : '○ idle' }}
      </span>
    </div>
    <div :style="{ height: heightPx + 'px' }" class="editor-wrap">
      <div ref="editorRoot" class="editor"></div>
    </div>
    <div class="footer" v-if="params.length || status.kind === 'error' || status.kind === 'running'">
      <div v-if="params.length" class="params">
        <div v-for="p in params" :key="p.name" class="prow">
          <span class="pname">{{ p.name }}</span>
          <input
            type="range"
            :min="p.min" :max="p.max" :step="(p.max - p.min) / 200"
            :value="p.current"
            @input="onParamChange(p, ($event.target as HTMLInputElement).valueAsNumber)"
          />
          <span class="pval">{{ p.current.toFixed(3) }}</span>
        </div>
      </div>
      <div class="meter" v-if="status.kind === 'running'">
        <div class="bar2"><div class="fill" :style="{ width: Math.min(100, meterPeak * 100) + '%' }"></div></div>
        <span class="num">peak {{ meterPeak.toFixed(3) }}</span>
      </div>
      <pre v-if="status.kind === 'error'" class="err">{{ status.message }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tryit {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  margin: 16px 0;
  overflow: hidden;
  background: #1e1e1e;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #252526;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 12px;
  color: #ddd;
}
button.run, button.stop {
  background: #0078d4;
  color: white;
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
button.stop {
  background: #5a5a5a;
}
button.run:hover { background: #1488da; }
button.stop:hover:not(:disabled) { background: #6a6a6a; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
.label {
  color: #888;
  font-family: "JetBrains Mono", "SF Mono", monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.status {
  margin-left: auto;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  letter-spacing: 0.06em;
}
.status.running { color: #00d4aa; }
.status.error { color: #ff5577; }
.status.idle { color: #888; }
.editor-wrap { background: #1e1e1e; }
.editor { width: 100%; height: 100%; }
.footer {
  padding: 8px 10px;
  background: #252526;
  border-top: 1px solid var(--vp-c-divider);
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.params { flex: 1; min-width: 220px; }
.prow {
  display: grid;
  grid-template-columns: 80px 1fr 50px;
  align-items: center;
  gap: 6px;
  margin: 3px 0;
  font-size: 11px;
}
.pname { color: #aaa; font-family: "JetBrains Mono", monospace; }
.prow input[type=range] { width: 100%; }
.pval { color: #00d4aa; font-family: "JetBrains Mono", monospace; font-size: 10px; text-align: right; }
.meter {
  width: 180px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bar2 {
  height: 6px;
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: linear-gradient(90deg, #00d4aa, #ffb84d, #ff5577);
  transition: width 0.05s linear;
}
.meter .num { color: #888; font-size: 10px; font-family: "JetBrains Mono", monospace; }
.err {
  width: 100%;
  margin: 0;
  padding: 8px;
  background: #2a1a1a;
  color: #ff8899;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
