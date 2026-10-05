<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import MonacoEditor from "../components/MonacoEditor.vue";
import PlaygroundHelp from "../components/PlaygroundHelp.vue";
import type { EditorDiagnostic } from "../editor/protocol.ts";
import { useExpandedEditor } from "../composables/useExpandedEditor.ts";
import { useUnworkletDemo } from "../composables/useUnworkletDemo.ts";
import type { SourceType } from "../composables/useUnworkletDemo.ts";
import { exampleBySlug } from "../examples.ts";

const props = defineProps<{ slug: string }>();
const ex = exampleBySlug(props.slug);
const src = ref(ex?.source ?? "");
const editor = ref<{
  focus(): void;
  reveal(diagnostic: EditorDiagnostic): void;
  document(): { uri: string; version: number; source: string } | undefined;
}>();
const workbench = ref<HTMLDialogElement>();
const {
  expanded,
  toggle: toggleExpanded,
  restore: restoreEditor,
  containFocus,
} = useExpandedEditor(workbench, () => editor.value?.focus());
const help = ref<"api" | "sugar" | null>(null);
const liveDiagnostics = ref<EditorDiagnostic[]>([]);
const assistanceStatus = ref("Loading editor assistance…");
const compileDiagnostic = ref<{ version: number; diagnostic: EditorDiagnostic }>();
function onDiagnostics(diagnostics: EditorDiagnostic[], status: string): void {
  liveDiagnostics.value = diagnostics;
  assistanceStatus.value = status;
}
function sourceLocation(diagnostic: EditorDiagnostic): string {
  if (diagnostic.start === undefined) return "Document";
  const lines = src.value.slice(0, diagnostic.start).split("\n");
  return `Line ${lines.length}, column ${lines[lines.length - 1]!.length + 1}`;
}
async function closeHelp(): Promise<void> {
  help.value = null;
  await nextTick();
  editor.value?.focus();
}
watch(src, () => {
  compileDiagnostic.value = undefined;
});

const {
  status,
  failure,
  ready,
  playing,
  busy,
  params,
  sourceType,
  freq,
  prepare,
  play,
  stop,
  setSource,
  setFreq,
  setParam,
  noteOn,
  noteOff,
  recompile,
  loadFile,
  destroy,
} = useUnworkletDemo();

watch(failure, (value) => {
  if (value?.phase !== "compile" || value !== compileDiagnostic.value?.diagnostic)
    compileDiagnostic.value = undefined;
});

const WAVES: { value: SourceType; label: string }[] = [
  { value: "sawtooth", label: "Sawtooth" },
  { value: "sine", label: "Sine" },
  { value: "square", label: "Square" },
  { value: "triangle", label: "Triangle" },
  { value: "noise", label: "White noise" },
];

// One octave of white keys, held-to-sound.
const KEYS = [
  { note: 60, label: "C" },
  { note: 62, label: "D" },
  { note: 64, label: "E" },
  { note: 65, label: "F" },
  { note: 67, label: "G" },
  { note: 69, label: "A" },
  { note: 71, label: "B" },
  { note: 72, label: "C" },
];
const down = reactive(new Set<number>());
function press(note: number): void {
  if (down.has(note)) return;
  down.add(note);
  noteOn(note);
}
function release(note: number): void {
  if (down.delete(note)) noteOff(note);
}

async function doRecompile(): Promise<void> {
  if (busy.value || !ready.value) return;
  const document = editor.value?.document();
  compileDiagnostic.value = undefined;
  await recompile(src.value);
  const current = editor.value?.document();
  if (
    failure.value?.phase === "compile" &&
    document &&
    current?.uri === document.uri &&
    current.version === document.version
  )
    compileDiagnostic.value = { version: document.version, diagnostic: failure.value };
}
function onFile(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadFile(file);
}
function fmtVal(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
}

// Space toggles play / stop for effects — unless you're typing in the editor or a control.
function onGlobalKey(e: KeyboardEvent): void {
  if (help.value || e.code !== "Space" || ex?.kind !== "effect" || !ready.value) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, a[href], input, textarea, select, .monaco-host")) return;
  e.preventDefault();
  if (playing.value) stop();
  else void play();
}

onMounted(() => {
  if (ex) void prepare(ex);
  window.addEventListener("keydown", onGlobalKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKey);
  void destroy();
});
</script>

<template>
  <RouterLink to="/" class="crumb">← examples</RouterLink>

  <template v-if="ex">
    <div class="ex-head">
      <h1>{{ ex.title }}</h1>
      <span class="tag" :class="ex.kind">{{ ex.kind }}</span>
    </div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p class="ex-blurb" v-html="ex.blurb.replace(/`([^`]+)`/g, '<code>$1</code>')"></p>

    <dialog
      id="playground-workbench"
      ref="workbench"
      open
      class="workbench"
      :class="{ expanded }"
      :role="expanded ? 'dialog' : 'region'"
      :aria-modal="expanded ? 'true' : undefined"
      :aria-label="expanded ? 'Expanded playground' : 'Playground'"
      @cancel.prevent="restoreEditor"
      @keydown="containFocus"
    >
      <div class="editor-wrap">
        <div class="editor-bar">
          <span class="file">{{ ex.slug }}.uwk.ts</span>
          <div class="editor-help-actions">
            <button @click="help = 'api'">API reference</button>
            <button @click="help = 'sugar'">Sugar help</button>
            <button
              type="button"
              :aria-expanded="expanded"
              aria-controls="playground-workbench"
              :aria-label="expanded ? 'Restore editor' : 'Expand editor'"
              @click="toggleExpanded"
            >
              {{ expanded ? "Restore editor" : "Expand editor" }}
              <span v-if="expanded" aria-hidden="true">Esc</span>
            </button>
          </div>
          <span class="label" style="text-transform: none">
            <kbd>⌘</kbd> <kbd>⏎</kbd>&nbsp; recompile
          </span>
        </div>
        <MonacoEditor
          ref="editor"
          v-model="src"
          :filename="ex.slug"
          :compile-diagnostic="compileDiagnostic"
          @submit="doRecompile"
          @diagnostics="onDiagnostics"
        />
        <section class="source-diagnostics" aria-label="Source diagnostics">
          <p role="status">{{ assistanceStatus }}</p>
          <ul v-if="liveDiagnostics.length">
            <li v-for="(diagnostic, index) in liveDiagnostics" :key="index">
              <button
                v-if="diagnostic.start !== undefined"
                class="diagnostic-location"
                @click="editor?.reveal(diagnostic)"
              >
                {{ sourceLocation(diagnostic) }}
              </button>
              <span v-else>Document</span>
              <strong
                >{{ diagnostic.severity }} · {{ diagnostic.phase }} · {{ diagnostic.code }}</strong
              >
              <span>{{ diagnostic.message }}</span>
            </li>
          </ul>
        </section>
      </div>

      <div class="panel">
        <div class="panel-block">
          <span class="label">Transport</span>
          <div class="transport">
            <template v-if="ex.kind === 'effect'">
              <button class="primary" :disabled="busy || !ready" @click="play">▶ Play</button>
              <button :disabled="!playing" @click="stop">■ Stop</button>
            </template>
            <button :disabled="busy || !ready" @click="doRecompile">↻ Recompile</button>
          </div>
          <p v-if="ex.kind === 'effect'" class="panel-hint"><kbd>Space</kbd> play / stop</p>
        </div>

        <div v-if="ex.kind === 'effect'" class="panel-block">
          <span class="label">Input source</span>
          <div class="field">
            <select
              :value="sourceType"
              @change="setSource(($event.target as HTMLSelectElement).value as SourceType)"
            >
              <option v-for="w in WAVES" :key="w.value" :value="w.value">{{ w.label }}</option>
            </select>
          </div>
          <div v-if="sourceType !== 'noise'" class="field">
            <div class="field-row">
              <span class="name">freq</span><span class="val">{{ freq.toFixed(0) }} Hz</span>
            </div>
            <input
              type="range"
              min="40"
              max="880"
              step="1"
              :value="freq"
              @input="setFreq(Number(($event.target as HTMLInputElement).value))"
            />
          </div>
          <div class="field">
            <input type="file" accept="audio/*" @change="onFile" />
          </div>
        </div>

        <div v-else class="panel-block">
          <span class="label">Keyboard — hold to play</span>
          <div class="keys">
            <div
              v-for="k in KEYS"
              :key="k.note"
              class="key"
              :class="{ down: down.has(k.note) }"
              @pointerdown="press(k.note)"
              @pointerup="release(k.note)"
              @pointerleave="release(k.note)"
            >
              {{ k.label }}
            </div>
          </div>
        </div>

        <div v-if="params.length" class="panel-block">
          <span class="label">Parameters</span>
          <div v-for="p in params" :key="p.name" class="field">
            <div class="field-row">
              <span class="name">{{ p.name }}</span
              ><span class="val">{{ fmtVal(p.value) }}</span>
            </div>
            <input
              type="range"
              :min="p.min"
              :max="p.max"
              :step="(p.max - p.min) / 100"
              v-model.number="p.value"
              @input="setParam(p.name, p.value)"
            />
          </div>
        </div>

        <p class="status" :class="{ live: playing }"><span class="dot" />{{ status }}</p>
        <div v-if="failure" class="error" role="alert" aria-label="Compilation and runtime errors">
          <strong>{{ failure.severity }} · {{ failure.phase }} · {{ failure.code }}</strong>
          <p>{{ failure.message }}</p>
          <button
            v-if="failure.phase === 'compile' && compileDiagnostic?.diagnostic.start !== undefined"
            @click="editor?.reveal(compileDiagnostic.diagnostic)"
          >
            Show {{ sourceLocation(compileDiagnostic.diagnostic) }}
          </button>
          <p v-else>No current source location is available.</p>
        </div>
      </div>
    </dialog>
  </template>
  <PlaygroundHelp v-if="help" :initial-tab="help" @close="closeHelp" />
  <p v-if="!ex">Example not found. <RouterLink to="/">Back to examples</RouterLink></p>
</template>

<style scoped>
.workbench {
  position: static;
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
}
.workbench.expanded {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100dvh;
  max-height: none;
  padding: 0.75rem;
  background: var(--bg);
  grid-template-columns: minmax(0, 1fr) 280px;
  align-items: stretch;
  gap: 0.75rem;
  overflow: hidden;
}
.workbench.expanded::backdrop {
  background: var(--bg);
}
.expanded .editor-wrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.expanded :deep(.monaco-host) {
  flex: 1;
  height: 0;
  min-height: 0;
}
.expanded .source-diagnostics {
  flex-shrink: 0;
  max-height: min(25%, 220px);
}
.expanded .panel {
  min-height: 0;
  overflow: auto;
  padding: 2px;
}
.editor-bar {
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 8px;
}
.editor-help-actions {
  flex-wrap: wrap;
}
.editor-help-actions button span {
  color: var(--muted);
}
@media (max-width: 860px) {
  .workbench.expanded {
    padding: 0.5rem;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 24%);
    gap: 0.5rem;
  }
}

.editor-help-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.editor-help-actions button {
  font-size: 11px;
  padding: 3px 7px;
}
.source-diagnostics {
  border-top: 1px solid #e2e8f0;
  padding: 10px 14px;
  max-height: 220px;
  overflow: auto;
  font-size: 12px;
  background: #f8fafc;
}
.source-diagnostics p {
  margin: 0;
  color: #475569;
}
.source-diagnostics ul {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}
.source-diagnostics li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 8px 0;
  border-top: 1px solid #e2e8f0;
}
.source-diagnostics li > span:last-child {
  flex-basis: 100%;
  white-space: pre-wrap;
}
.diagnostic-location {
  padding: 0;
  border: 0;
  text-decoration: underline;
  font-size: inherit;
}
.error p {
  white-space: pre-wrap;
}
@media (max-width: 640px) {
  .editor-bar {
    flex-wrap: wrap;
    gap: 8px;
  }
  .editor-help-actions {
    margin-left: 0;
  }
}
</style>
