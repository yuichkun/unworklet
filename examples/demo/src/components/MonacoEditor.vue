<script setup lang="ts">
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  attachEditorAssistance,
  setDiagnostics,
  sourceRange,
} from "../editor/monaco-assistance.ts";
import type { EditorDiagnostic } from "../editor/protocol.ts";

const monacoEnv = self as unknown as { MonacoEnvironment?: monaco.Environment };
monacoEnv.MonacoEnvironment ??= {
  getWorker: (): Worker => new editorWorker(),
};

// A light theme matching the demo's "Technical Precision" palette — Slate 50
// surface with a low-vibrancy syntax palette (DESIGN.md § Code Blocks).
monaco.editor.defineTheme("uwk-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "94a3b8", fontStyle: "italic" },
    { token: "keyword", foreground: "7c3aed" },
    { token: "string", foreground: "0e9384" },
    { token: "number", foreground: "b45309" },
    { token: "type", foreground: "0369a1" },
    { token: "delimiter", foreground: "64748b" },
    { token: "identifier", foreground: "0f172a" },
  ],
  colors: {
    "editor.background": "#f8fafc",
    "editor.foreground": "#0f172a",
    "editorLineNumber.foreground": "#cbd5e1",
    "editorLineNumber.activeForeground": "#64748b",
    "editor.selectionBackground": "#bae6fd66",
    "editor.lineHighlightBackground": "#eef2f6",
    "editorCursor.foreground": "#0284c7",
    "editorIndentGuide.background1": "#e2e8f0",
  },
});

const props = defineProps<{
  modelValue: string;
  filename?: string;
  compileDiagnostic?: { version: number; diagnostic: EditorDiagnostic };
}>();
const emit = defineEmits<{
  "update:modelValue": [string];
  submit: [];
  diagnostics: [EditorDiagnostic[], string];
}>();

const host = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let assistance: { dispose(): void } | undefined;
let contentListener: monaco.IDisposable | undefined;

defineExpose({
  focus: () => editor?.focus(),
  document: () => {
    const model = editor?.getModel();
    return model
      ? { uri: model.uri.toString(), version: model.getVersionId(), source: model.getValue() }
      : undefined;
  },
  reveal: (diagnostic: EditorDiagnostic) => {
    const model = editor?.getModel();
    if (!model || diagnostic.start === undefined) return;
    const range = sourceRange(model, diagnostic.start, diagnostic.length ?? 0);
    editor!.setSelection(range);
    editor!.revealRangeInCenter(range);
    editor!.focus();
  },
});

onMounted(() => {
  if (!host.value) return;
  const uri = monaco.Uri.parse(
    `file:///playground/${encodeURIComponent(props.filename ?? "processor")}-${crypto.randomUUID()}.uwk.ts`,
  );
  const model = monaco.editor.createModel(props.modelValue, "typescript", uri);
  editor = monaco.editor.create(host.value, {
    model,
    theme: "uwk-light",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 21,
    fontFamily: '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontLigatures: true,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    tabSize: 2,
    renderLineHighlight: "line",
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    padding: { top: 12, bottom: 12 },
  });
  contentListener = editor.onDidChangeModelContent(() => {
    setDiagnostics(model, "uwk-compile", []);
    emit("update:modelValue", editor!.getValue());
  });
  assistance = attachEditorAssistance(model, (diagnostics, status) =>
    emit("diagnostics", diagnostics, status),
  );
  // ⌘⏎ / Ctrl+⏎ recompiles, so the user can edit and hear it without reaching for the button.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit("submit"));
});

// Sync external changes (switching examples) into the editor without clobbering
// the user's own edits.
watch(
  () => props.modelValue,
  (v) => {
    if (editor && v !== editor.getValue()) editor.setValue(v);
  },
);

watch(
  () => props.compileDiagnostic,
  (value) => {
    const model = editor?.getModel();
    if (model)
      setDiagnostics(
        model,
        "uwk-compile",
        value?.version === model.getVersionId() ? [value.diagnostic] : [],
      );
  },
);

onBeforeUnmount(() => {
  assistance?.dispose();
  contentListener?.dispose();
  const model = editor?.getModel();
  editor?.dispose();
  model?.dispose();
  editor = null;
});
</script>

<template>
  <div ref="host" class="monaco-host"></div>
</template>
