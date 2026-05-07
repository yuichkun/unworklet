<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { ref, computed, onBeforeUnmount, watch, nextTick } from "vue";
import type { NodeDef, PatchNode } from "../../types";
// Monaco is imported eagerly here. The Vite build splits this into its own
// chunk, so the patcher only loads it when the GenView modal opens — but
// the import itself proves we're not a textarea.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as monaco from "monaco-editor";
import { GEN_DTS } from "./gen-monaco-types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onAttrChange: () => void }>>();

const showEditor = ref(false);
const editorEl = ref<HTMLElement | null>(null);
const draftCode = ref(String(props.data.node.attrs?.code ?? ""));
const outletCount = computed(() => Number(props.data.node.attrs?.outletCount ?? 1));
const inletCount = computed(() => Number(props.data.node.attrs?.inletCount ?? 1));

let editor: monaco.editor.IStandaloneCodeEditor | null = null;

async function open() {
  draftCode.value = String(props.data.node.attrs?.code ?? "");
  showEditor.value = true;
  await nextTick();
  await mountEditor();
}

let monacoConfigured = false;
function configureMonacoOnce() {
  if (monacoConfigured) return;
  monacoConfigured = true;
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    allowNonTsExtensions: true,
    noImplicitAny: false,
    strict: false,
    typeRoots: [],
    lib: ["es2022"],
  });
  // Suppress diagnostics for top-level code in a gen~ snippet (no imports
  // are needed since the runtime injects all bindings into scope).
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [1108, 2304, 2552, 1378],
  });
  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    GEN_DTS,
    "file:///gen.d.ts",
  );
}

async function mountEditor() {
  if (!editorEl.value) return;
  configureMonacoOnce();
  editor?.dispose();
  editor = monaco.editor.create(editorEl.value, {
    value: draftCode.value,
    language: "typescript",
    theme: "vs-dark",
    fontSize: 13,
    minimap: { enabled: false },
    automaticLayout: true,
    tabSize: 2,
    scrollBeyondLastLine: false,
    lineNumbers: "on",
  });
}

function apply() {
  const code = editor?.getValue() ?? draftCode.value;
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), code };
  showEditor.value = false;
  editor?.dispose();
  editor = null;
  props.data.onAttrChange();
}

function cancel() {
  showEditor.value = false;
  editor?.dispose();
  editor = null;
}

watch(showEditor, (v) => {
  if (!v && editor) {
    editor.dispose();
    editor = null;
  }
});

onBeforeUnmount(() => {
  editor?.dispose();
  editor = null;
});
</script>

<template>
  <div class="node-box structural gen-box" @dblclick="open" title="Double-click to edit gen~ code">
    <Handle
      v-for="i in inletCount"
      :key="`in-${i - 1}`"
      :id="`in-${i - 1}`"
      class="audio-handle"
      :position="Position.Top"
      type="target"
      :style="{ left: `${i * 100 / (inletCount + 1)}%` }"
    />
    <div class="header">⚡ gen~ <span class="hint">(double-click)</span></div>
    <div class="body">
      <pre class="snippet">{{ String(data.node.attrs?.code ?? "// (empty)").slice(0, 60) }}…</pre>
    </div>
    <Handle
      v-for="i in outletCount"
      :key="`out-${i - 1}`"
      :id="`out-${i - 1}`"
      class="audio-handle"
      :position="Position.Bottom"
      type="source"
      :style="{ left: `${i * 100 / (outletCount + 1)}%` }"
    />
    <Teleport to="body">
      <div v-if="showEditor" class="editor-modal" @click.self="cancel">
        <div class="editor-frame">
          <header>
            <span class="title">⚡ gen~ — inline DSP code</span>
            <span class="hint">in1..inN, return [out0, out1, ...]; state / buffer / chain methods in scope</span>
            <button class="primary" @click="apply">apply</button>
            <button @click="cancel">cancel</button>
          </header>
          <div ref="editorEl" class="monaco-host" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.gen-box { border-color: #b685ff; }
.gen-box:hover { border-color: #d4b8ff; }
.snippet {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #aaa;
  margin: 0;
  white-space: pre-wrap;
}
.hint { color: #888; font-weight: normal; font-size: 10px; }
.editor-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}
.editor-frame {
  background: #21222a;
  border: 1px solid #494a52;
  border-radius: 6px;
  width: 80vw;
  max-width: 1000px;
  height: 70vh;
  display: flex;
  flex-direction: column;
}
.editor-frame header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid #3d3e45;
  background: #1a1b1e;
}
.editor-frame header .title {
  color: #b685ff;
  font-family: "JetBrains Mono", monospace;
  font-weight: 600;
}
.editor-frame header .hint {
  flex: 1;
  color: #888;
  font-size: 10px;
}
.monaco-host {
  flex: 1;
  min-height: 0;
}
</style>
