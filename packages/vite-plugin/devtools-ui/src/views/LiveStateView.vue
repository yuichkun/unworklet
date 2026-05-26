<script setup lang="ts">
// A-4 で fill。 publish slot 全 値 + buffer waveform canvas。
</script>

<template>
  <div class="view-placeholder">
    <div class="ph-title">Live state</div>
    <div class="ph-desc">Cross-node publish slot view (= A-4 sub-step で fill)</div>
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
