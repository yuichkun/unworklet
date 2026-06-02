<script setup lang="ts">
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
// The Monarch TypeScript grammar = syntax highlighting only, with no language
// service (so no worker, no type checking, no completion). That is all the
// `.uwk.ts` editor needs — the sources reference DSL globals (`audioInput`,
// `process`, `$prev`, …) that have no ambient types here, and a language service
// would only flag them as errors.
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

// One-time Vite worker wiring. With highlighting-only there is no language worker;
// monaco still uses the base editor worker for core text operations.
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

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [string]; submit: [] }>();

const host = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

onMounted(() => {
  if (!host.value) return;
  editor = monaco.editor.create(host.value, {
    value: props.modelValue,
    language: "typescript",
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
  editor.onDidChangeModelContent(() => emit("update:modelValue", editor!.getValue()));
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

onBeforeUnmount(() => {
  editor?.getModel()?.dispose();
  editor?.dispose();
  editor = null;
});
</script>

<template>
  <div ref="host" class="monaco-host"></div>
</template>
