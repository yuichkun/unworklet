<script setup lang="ts">
// A-5 で fill。 5 sub-tab = Waveform / Spectrogram / Record / Latency / Memory。
</script>

<template>
  <div class="view-placeholder">
    <div class="ph-title">Signals &amp; performance</div>
    <div class="ph-desc">
      Waveform / Spectrogram / Record-Play / Latency / Memory (= A-5 sub-step で fill)
    </div>
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
