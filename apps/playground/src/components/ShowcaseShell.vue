<script setup lang="ts">
const props = defineProps<{
  title: string;
  subtitle?: string;
  description?: string;
}>();
</script>

<template>
  <div class="shell col">
    <header>
      <div>
        <h1>{{ title }}</h1>
        <div v-if="subtitle" class="muted">{{ subtitle }}</div>
      </div>
      <div v-if="description" class="muted desc">{{ description }}</div>
    </header>
    <slot />
  </div>
</template>

<style scoped>
.shell {
  max-width: 1100px;
}
header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.desc {
  max-width: 760px;
  font-size: 14px;
  line-height: 1.5;
}
</style>
