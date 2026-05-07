<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { ref, computed } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onAttrChange: () => void }>>();

const showEditor = ref(false);
const draftCode = ref(String(props.data.node.attrs?.code ?? ""));
const outletCount = computed(() => Number(props.data.node.attrs?.outletCount ?? 1));
const inletCount = ref(1);

function open() {
  draftCode.value = String(props.data.node.attrs?.code ?? "");
  showEditor.value = true;
}
function apply() {
  props.data.node.attrs = { ...(props.data.node.attrs ?? {}), code: draftCode.value };
  showEditor.value = false;
  props.data.onAttrChange();
}
function cancel() { showEditor.value = false; }
</script>
<template>
  <div class="node-box structural" @dblclick="open">
    <Handle
      v-for="i in inletCount"
      :key="`in-${i - 1}`"
      :id="`in-${i - 1}`"
      class="audio-handle"
      :position="Position.Top"
      type="target"
      :style="{ left: `${i * 100 / (inletCount + 1)}%` }"
    />
    <div class="header">gen~ <span class="hint">(double-click to edit)</span></div>
    <div class="body">
      <pre class="snippet">{{ String(data.node.attrs?.code ?? "").slice(0, 60) }}…</pre>
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
    <div v-if="showEditor" class="editor-modal" @click.self="cancel">
      <div class="editor-frame">
        <header>
          <span>gen~ code</span>
          <button class="primary" @click="apply">apply</button>
          <button @click="cancel">cancel</button>
        </header>
        <textarea v-model="draftCode" autofocus spellcheck="false"></textarea>
      </div>
    </div>
  </div>
</template>
<style scoped>
.snippet {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #aaa;
  margin: 0;
  white-space: pre-wrap;
}
.hint { color: #888; font-weight: normal; }
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
  max-width: 900px;
  height: 60vh;
  display: flex;
  flex-direction: column;
}
.editor-frame header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #3d3e45;
  background: #1a1b1e;
}
.editor-frame header span { flex: 1; color: #b685ff; font-family: "JetBrains Mono", monospace; font-weight: 600; }
.editor-frame textarea {
  flex: 1;
  background: #1a1b1e;
  color: #d8d9dc;
  border: none;
  padding: 12px 14px;
  font-family: "JetBrains Mono", "SF Mono", monospace;
  font-size: 13px;
  outline: none;
  resize: none;
  line-height: 1.55;
}
</style>
