<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{ node: PatchNode; def: NodeDef; onParam: (v: number) => void }>>();

const lowNote = computed(() => Number(props.data.node.attrs?.lowNote ?? 48));
const octaves = computed(() => Number(props.data.node.attrs?.octaves ?? 2));
const noteCount = computed(() => octaves.value * 12);

const heldNote = ref<number | null>(null);
const PATTERN = [0, 2, 4, 5, 7, 9, 11]; // white-key offsets within an octave
function isBlack(n: number) {
  const o = (n - lowNote.value) % 12;
  return [1, 3, 6, 8, 10].includes((o + 12) % 12);
}

function press(n: number) {
  heldNote.value = n;
  // Single paramSpec — we send the note number for now. (gate via a
  // separate notein.gate paramSpec is left as a stretch; for the
  // monosynth example we use kslider→mtof~→cycle~ + a separate toggle.)
  props.data.onParam(n);
}
function release() {
  heldNote.value = null;
  // Set value to 0 (note off). In a full implementation we'd send gate=0
  // on outlet 1.
}
</script>
<template>
  <div class="node-box ui-node">
    <div class="header">{{ data.node.type }} <span class="hint" v-if="heldNote !== null">: {{ heldNote }}</span></div>
    <div class="body kslider-body">
      <div class="kbd">
        <button
          v-for="n in noteCount"
          :key="n"
          class="key"
          :class="{ black: isBlack(lowNote + n - 1), held: heldNote === lowNote + n - 1 }"
          @pointerdown="press(lowNote + n - 1)"
          @pointerup="release"
          @pointerleave="heldNote === lowNote + n - 1 && release()"
        ></button>
      </div>
    </div>
    <Handle id="out-0" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '40%' }" />
    <Handle id="out-1" class="control-handle" :position="Position.Bottom" type="source" :style="{ left: '60%' }" />
  </div>
</template>
<style scoped>
.kslider-body { padding: 4px; }
.kbd { display: flex; gap: 0; }
.key {
  background: #f0f0f0;
  border: 1px solid #494a52;
  width: 14px;
  height: 50px;
  padding: 0;
  border-radius: 0 0 2px 2px;
  cursor: pointer;
  position: relative;
}
.key:hover { background: #e0e0e0; }
.key.held { background: #00d4aa; }
.key.black {
  background: #21222a;
  height: 32px;
  width: 10px;
  margin: 0 -5px;
  z-index: 1;
}
.key.black.held { background: #00b893; }
.hint { color: #aaa; font-weight: normal; }
</style>
