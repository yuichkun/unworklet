<script setup lang="ts">
import { ref, watchEffect, onBeforeUnmount } from "vue";
import { useProcessor } from "../audio/useProcessor";
import ShowcaseShell from "../components/ShowcaseShell.vue";
import AudioSourcePicker from "../components/AudioSourcePicker.vue";
import ParamControl from "../components/ParamControl.vue";
import LevelMeter from "../components/LevelMeter.vue";
import Oscilloscope from "../components/Oscilloscope.vue";

const { node } = useProcessor({ processorName: "lookaheadLimiter" });
const source = ref<AudioNode | null>(null);
function onSource(s: AudioNode | null) {
  source.value = s;
  if (s && node.value) {
    try {
      s.connect(node.value.node, 0, 0);
    } catch {}
  }
}

const grDb = ref(0);
const overshoots = ref<Array<{ atSample: number; channel: number; level: number }>>([]);
let unsub: (() => void) | null = null;
let unsubE: (() => void) | null = null;
watchEffect(() => {
  unsub?.();
  unsubE?.();
  if (node.value) {
    unsub = node.value.state.gainReductionDb!.subscribe((v: number) => (grDb.value = v));
    unsubE = node.value.events.overshoot!.on((p) => {
      overshoots.value.push(p);
      if (overshoots.value.length > 60) overshoots.value.shift();
    });
  }
});
onBeforeUnmount(() => {
  unsub?.();
  unsubE?.();
});
</script>

<template>
  <ShowcaseShell
    title="Lookahead Limiter"
    subtitle="Example 04"
    description="5 ms lookahead delay line, envelope follower, and sample-accurate overshoot events. Drive a hot signal through it and watch GR follow."
  >
    <div class="row">
      <AudioSourcePicker @source="onSource" />
      <div class="panel col">
        <h3>Parameters</h3>
        <div class="row">
          <ParamControl :param="node?.params.ceiling" label="Ceiling" :min="-24" :max="0" :default="-1" unit="dB" />
          <ParamControl :param="node?.params.releaseMs" label="Release" :min="1" :max="500" exp :default="50" unit="ms" />
        </div>
      </div>
      <div class="panel col">
        <h3>Gain reduction</h3>
        <LevelMeter :value="-grDb" :max="24" label="GR (dB)" />
      </div>
    </div>
    <div class="row">
      <Oscilloscope :source="node?.node ?? null" label="Output waveform" />
      <div class="panel events col">
        <h3>Recent overshoot events</h3>
        <div class="event-list">
          <div v-if="overshoots.length === 0" class="muted small">No overshoots yet.</div>
          <div v-for="(o, i) in overshoots.slice().reverse()" :key="i" class="evt">
            <span class="muted small">ch{{ o.channel }}</span>
            <span class="small">level {{ o.level.toFixed(3) }}</span>
            <span class="muted small">@ {{ o.atSample }}</span>
          </div>
        </div>
      </div>
    </div>
  </ShowcaseShell>
</template>

<style scoped>
.events {
  flex: 1;
  min-width: 280px;
}
.event-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}
.evt {
  display: flex;
  gap: 8px;
  font-family:
    "JetBrains Mono", "SF Mono", monospace;
}
.small {
  font-size: 12px;
}
</style>
