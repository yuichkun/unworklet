<script setup lang="ts">
import { RouterLink } from "vue-router";

const cards = [
  { to: "/01-gain", title: "Stereo Gain", subtitle: "Param + state.publish meter", group: "Effect" },
  { to: "/02-eq", title: "3-Band Biquad EQ", subtitle: "L1 helper + L2 subgraph cascade", group: "Effect" },
  { to: "/03-lineareq", title: "Linear-Phase EQ", subtitle: "Partitioned FIR + SIMD", group: "Effect" },
  { to: "/04-limiter", title: "Lookahead Limiter", subtitle: "buffer + event<T>", group: "Effect" },
  { to: "/05-granular", title: "Granular Sampler", subtitle: "buffer.publish + MIDI", group: "Instrument" },
  { to: "/06-arp", title: "MIDI Arpeggiator", subtitle: "midiInput + midiOutput", group: "MIDI" },
  { to: "/07-reverb", title: "Convolution Reverb", subtitle: "snapshot + migration", group: "Effect" },
  { to: "/08-poly", title: "Polyphonic Synth", subtitle: "voice subgraph + sidechain", group: "Instrument" },
  { to: "/09-delay", title: "Feedback Delay", subtitle: "Stereo ping-pong delay line", group: "Effect" },
  { to: "/10-chorus", title: "Stereo Chorus", subtitle: "LFO-modulated delays", group: "Effect" },
  { to: "/11-dist", title: "Distortion", subtitle: "tanh saturator + tone", group: "Effect" },
  { to: "/12-drum", title: "Drum Sampler", subtitle: "8-pad + MIDI triggers", group: "Instrument" },
  { to: "/13-comp", title: "Compressor", subtitle: "Soft-knee dynamic control", group: "Effect" },
  { to: "/14-fm", title: "FM Synth", subtitle: "6-voice 2-op FM", group: "Instrument" },
];
</script>

<template>
  <div class="home col">
    <section class="hero panel">
      <div class="hero-text">
        <h1>unworklet playground</h1>
        <p class="muted">
          Realtime DSP showcases compiled from <code>unworklet</code> processors and running through a
          single <code>AudioWorklet</code> module. Every showcase below is one <code>defineProcessor</code>
          call away.
        </p>
        <p class="muted small">
          Audio runs at 48 kHz with a 128-sample render quantum. Latency = <code>baseLatency + outputLatency</code>
          shown in the header. Click any card to open a showcase.
        </p>
      </div>
    </section>
    <section>
      <h2>Effects</h2>
      <div class="grid">
        <RouterLink v-for="c in cards.filter(c => c.group === 'Effect')" :key="c.to" :to="c.to" class="card panel">
          <div class="title">{{ c.title }}</div>
          <div class="muted">{{ c.subtitle }}</div>
        </RouterLink>
      </div>
    </section>
    <section>
      <h2>Instruments</h2>
      <div class="grid">
        <RouterLink v-for="c in cards.filter(c => c.group === 'Instrument')" :key="c.to" :to="c.to" class="card panel">
          <div class="title">{{ c.title }}</div>
          <div class="muted">{{ c.subtitle }}</div>
        </RouterLink>
      </div>
    </section>
    <section>
      <h2>MIDI</h2>
      <div class="grid">
        <RouterLink v-for="c in cards.filter(c => c.group === 'MIDI')" :key="c.to" :to="c.to" class="card panel">
          <div class="title">{{ c.title }}</div>
          <div class="muted">{{ c.subtitle }}</div>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 1100px;
}
.hero {
  background: linear-gradient(120deg, #1a1d28, #1d2030);
}
.hero h1 {
  font-size: 28px;
}
.hero p {
  margin: 6px 0 0 0;
  max-width: 720px;
}
.small {
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.card {
  display: block;
  padding: 14px;
  cursor: pointer;
  transition: transform 80ms;
  color: var(--text);
}
.card:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
  color: var(--text);
}
.card .title {
  font-weight: 600;
  margin-bottom: 4px;
}
</style>
