<script setup lang="ts">
// A-3 で fill。 split = 左 audio graph + 右 selected node detail (AST/Build errors/State/Snapshot)。
</script>

<template>
  <div class="view-placeholder">
    <div class="ph-title">Audio graph</div>
    <div class="ph-desc">
      Full AudioContext graph + selected node detail (= A-3 sub-step で fill)
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
