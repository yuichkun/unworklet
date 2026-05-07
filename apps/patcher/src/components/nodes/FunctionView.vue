<script setup lang="ts">
import { Handle, Position, type NodeProps } from "@vue-flow/core";
import { computed, ref } from "vue";
import type { NodeDef, PatchNode } from "../../types";

const props = defineProps<NodeProps<{
  node: PatchNode;
  def: NodeDef;
  onAttrChange: () => void;
}>>();

const W = 220;
const H = 100;

const minY = computed(() => Number(props.data.node.attrs?.minY ?? 0));
const maxY = computed(() => Number(props.data.node.attrs?.maxY ?? 1));

const points = ref<Array<[number, number]>>(loadPoints());

function loadPoints(): Array<[number, number]> {
  try {
    const arr = JSON.parse(String(props.data.node.attrs?.points ?? "[]"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist() {
  const sorted = [...points.value].sort((a, b) => a[0] - b[0]);
  props.data.node.attrs = {
    ...(props.data.node.attrs ?? {}),
    points: JSON.stringify(sorted),
  };
  points.value = sorted;
  props.data.onAttrChange();
}

function toScreen(x: number, y: number) {
  const sx = x * (W - 12) + 6;
  const t = (y - minY.value) / (maxY.value - minY.value || 1);
  const sy = (1 - t) * (H - 12) + 6;
  return { sx, sy };
}
function fromScreen(sx: number, sy: number) {
  const x = Math.max(0, Math.min(1, (sx - 6) / (W - 12)));
  const yt = Math.max(0, Math.min(1, 1 - (sy - 6) / (H - 12)));
  const y = minY.value + yt * (maxY.value - minY.value);
  return { x, y };
}

const path = computed(() => {
  const sorted = [...points.value].sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return "";
  return sorted.map((p, i) => {
    const { sx, sy } = toScreen(p[0]!, p[1]!);
    return `${i === 0 ? "M" : "L"}${sx.toFixed(1)} ${sy.toFixed(1)}`;
  }).join(" ");
});

let dragIdx: number | null = null;
function onPointDown(e: MouseEvent, i: number) {
  e.stopPropagation();
  dragIdx = i;
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
function onMove(e: MouseEvent) {
  if (dragIdx == null) return;
  const svg = (e.currentTarget as any) ?? document.querySelector(`[data-fn-id='${props.data.node.id}']`);
  const rect = (svg as Element)?.getBoundingClientRect();
  if (!rect) return;
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const { x, y } = fromScreen(sx, sy);
  const pts = [...points.value];
  pts[dragIdx] = [x, y];
  points.value = pts;
}
function onUp() {
  dragIdx = null;
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
  persist();
}

function onSvgDoubleClick(e: MouseEvent) {
  const rect = (e.currentTarget as Element).getBoundingClientRect();
  const { x, y } = fromScreen(e.clientX - rect.left, e.clientY - rect.top);
  points.value = [...points.value, [x, y]];
  persist();
}
function removePoint(e: MouseEvent, i: number) {
  e.stopPropagation();
  e.preventDefault();
  if (points.value.length <= 2) return;
  points.value = points.value.filter((_, idx) => idx !== i);
  persist();
}
</script>

<template>
  <div class="node-box">
    <Handle
      id="in-0"
      class="audio-handle"
      :position="Position.Top"
      type="target"
      :style="{ left: '50%' }"
    />
    <div class="header">function <span class="hint">double-click to add, right-click to remove</span></div>
    <div class="body fn-body">
      <svg
        :width="W"
        :height="H"
        :data-fn-id="data.node.id"
        @dblclick="onSvgDoubleClick"
      >
        <rect :width="W" :height="H" fill="#0e0f12" />
        <path :d="path" stroke="#00d4aa" stroke-width="1.5" fill="none" />
        <circle
          v-for="(p, i) in points"
          :key="i"
          :cx="toScreen(p[0], p[1]).sx"
          :cy="toScreen(p[0], p[1]).sy"
          r="4"
          fill="#ffb84d"
          stroke="#21222a"
          stroke-width="1"
          style="cursor: grab;"
          @mousedown="onPointDown($event, i)"
          @contextmenu="removePoint($event, i)"
        />
      </svg>
    </div>
    <Handle
      id="out-0"
      class="audio-handle"
      :position="Position.Bottom"
      type="source"
      :style="{ left: '50%' }"
    />
  </div>
</template>

<style scoped>
.node-box { min-width: 232px; }
.fn-body { padding: 4px; }
.hint { color: #888; font-weight: normal; font-size: 9px; }
svg { display: block; border: 1px solid #2c2d31; border-radius: 3px; }
</style>
