<script setup lang="ts">
// A-6 で fill。 ports table + virtual keyboard inject。
</script>

<template>
  <div class="view-placeholder">
    <div class="ph-title">MIDI</div>
    <div class="ph-desc">Ports + virtual keyboard inject (= A-6 sub-step で fill)</div>
  </div>
</template>

<style scoped>
.view-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--u-text-dim);
  gap: 6px;
}
.ph-title {
  font-size: 18px;
  color: var(--u-text-muted);
}
.ph-desc {
  font-size: 12px;
}
</style>
