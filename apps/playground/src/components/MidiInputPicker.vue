<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { getMidiAccess } from "../audio/AudioEngine";

const emit = defineEmits<{ midiInput: [input: any | null] }>();

const inputs = ref<Array<{ id: string; name: string }>>([]);
const selected = ref<string>("");
const enabled = ref(false);
const error = ref<string>("");

let access: any = null;

async function load() {
  try {
    access = await getMidiAccess();
    const list: Array<{ id: string; name: string }> = [];
    for (const [, inp] of access.inputs) list.push({ id: inp.id, name: inp.name });
    inputs.value = list;
    enabled.value = true;
    if (list.length && !selected.value) selected.value = list[0]!.id;
  } catch (e: any) {
    error.value = "Web MIDI denied or unsupported";
  }
}

watch(selected, (id) => {
  if (!access) return;
  const inp = access.inputs.get(id);
  emit("midiInput", inp ?? null);
});

onMounted(load);
</script>

<template>
  <div class="picker panel">
    <h3>MIDI input</h3>
    <div class="row" v-if="!enabled">
      <button @click="load">Enable Web MIDI</button>
      <span class="muted" v-if="error">{{ error }}</span>
    </div>
    <div class="row" v-else>
      <select v-model="selected" :disabled="inputs.length === 0">
        <option v-if="inputs.length === 0" disabled>No MIDI inputs</option>
        <option v-for="i in inputs" :key="i.id" :value="i.id">{{ i.name }}</option>
      </select>
      <span class="muted">External hardware will route here</span>
    </div>
  </div>
</template>
