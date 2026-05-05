<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import Knob from "./Knob.vue";

const props = defineProps<{
  param: AudioParam | undefined;
  label: string;
  min: number;
  max: number;
  default?: number;
  exp?: boolean;
  unit?: string;
  format?: (v: number) => string;
}>();

const value = ref(props.default ?? props.min);

watch(value, (v) => {
  if (props.param) {
    try {
      props.param.setValueAtTime(v, props.param.context.currentTime);
    } catch {
      props.param.value = v;
    }
  }
});

onMounted(() => {
  if (props.param) {
    value.value = props.param.value;
  }
});
</script>

<template>
  <Knob
    v-model="value"
    :min="min"
    :max="max"
    :label="label"
    :exp="exp"
    :unit="unit"
    :format="format"
  />
</template>
