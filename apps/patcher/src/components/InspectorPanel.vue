<script setup lang="ts">
import { computed } from "vue";
import { registry } from "../registry";
import type { Patch, AttrDef } from "../types";

const props = defineProps<{ patch: Patch; selectedId: string | null }>();
const emit = defineEmits<{ (e: "change"): void }>();

const node = computed(() => props.patch.nodes.find((n) => n.id === props.selectedId));
const def = computed(() => (node.value ? registry[node.value.type] : undefined));

function setAttr(attr: AttrDef, raw: string) {
  if (!node.value) return;
  let value: any = raw;
  if (attr.kind === "number") value = Number(raw);
  else if (attr.kind === "boolean") value = !!raw;
  node.value.attrs = { ...(node.value.attrs ?? {}), [attr.name]: value };
  emit("change");
}

function setArg(idx: number, raw: string) {
  if (!node.value) return;
  const args = [...(node.value.args ?? [])];
  // try to coerce to number; otherwise leave string
  const n = Number(raw);
  args[idx] = Number.isFinite(n) ? n : raw;
  node.value.args = args;
  emit("change");
}
</script>

<template>
  <aside class="inspector">
    <header class="ihead">
      <span v-if="!node">no selection</span>
      <span v-else>
        <strong>{{ node.type }}</strong>
        <span class="muted"> · {{ node.id }}</span>
      </span>
    </header>
    <div v-if="node && def" class="ibody">
      <p class="desc">{{ def.description }}</p>

      <div v-if="def.defaultArgs?.length" class="section">
        <div class="section-h">args</div>
        <div v-for="(a, i) in def.defaultArgs" :key="i" class="row">
          <label>arg {{ i }}</label>
          <input
            type="text"
            :value="(node.args ?? def.defaultArgs)[i]"
            @change="(e) => setArg(i, (e.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <div v-if="def.attrs?.length" class="section">
        <div class="section-h">attributes</div>
        <div v-for="a in def.attrs" :key="a.name" class="row">
          <label>{{ a.name }}</label>
          <textarea
            v-if="a.kind === 'code'"
            class="code"
            :value="(node.attrs?.[a.name] as string) ?? a.default"
            @change="(e) => setAttr(a, (e.target as HTMLTextAreaElement).value)"
          />
          <input
            v-else
            :type="a.kind === 'number' ? 'number' : 'text'"
            :value="node.attrs?.[a.name] ?? a.default"
            :min="a.min"
            :max="a.max"
            @change="(e) => setAttr(a, (e.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <div class="section">
        <div class="section-h">ports</div>
        <div class="ports">
          <div>
            <div class="muted">inlets</div>
            <div v-for="(p, i) in def.inlets" :key="i" class="port">
              <span class="dot" :class="p.kind"></span>
              <span>{{ i }}: {{ p.label }}</span>
            </div>
          </div>
          <div>
            <div class="muted">outlets</div>
            <div v-for="(p, i) in def.outlets" :key="i" class="port">
              <span class="dot" :class="p.kind"></span>
              <span>{{ i }}: {{ p.label }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  width: 280px;
  border-left: 1px solid #3d3e45;
  background: #21222a;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.ihead {
  padding: 8px 12px;
  border-bottom: 1px solid #3d3e45;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  background: #1a1b1e;
}
.ihead strong { color: #00d4aa; }
.muted { color: #888; }
.ibody {
  padding: 10px 12px;
  overflow-y: auto;
}
.desc {
  font-size: 11px;
  color: #aaa;
  margin: 0 0 12px;
  line-height: 1.4;
}
.section {
  margin-bottom: 12px;
}
.section-h {
  font-size: 10px;
  text-transform: uppercase;
  color: #888;
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
}
.row label {
  width: 80px;
  font-size: 11px;
  color: #aaa;
}
.row input,
.row textarea {
  flex: 1;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
}
.row textarea.code {
  height: 200px;
  resize: vertical;
}
.ports {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  font-size: 11px;
}
.port {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot.audio { background: #00d4aa; }
.dot.control { background: #ffb84d; }
</style>
