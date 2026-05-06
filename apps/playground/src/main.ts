import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";

import App from "./App.vue";
import Home from "./views/Home.vue";
import StereoGain from "./views/StereoGain.vue";
import ThreeBandEQ from "./views/ThreeBandEQ.vue";
import LinearPhaseEQ from "./views/LinearPhaseEQ.vue";
import LookaheadLimiter from "./views/LookaheadLimiter.vue";
import GranularSampler from "./views/GranularSampler.vue";
import Arpeggiator from "./views/Arpeggiator.vue";
import ConvolutionReverb from "./views/ConvolutionReverb.vue";
import PolySynth from "./views/PolySynth.vue";
import FeedbackDelay from "./views/FeedbackDelay.vue";
import Chorus from "./views/Chorus.vue";
import Distortion from "./views/Distortion.vue";
import DrumSampler from "./views/DrumSampler.vue";
import Compressor from "./views/Compressor.vue";
import FmSynth from "./views/FmSynth.vue";
import CodePlayground from "./views/CodePlayground.vue";

import "./styles/main.css";

// Expose compiler + examples on window for the headless audio test harness
// (apps/playground/scripts/wasm-audio-test.ts). Production builds also
// include this so end-to-end tests can drive the same module the live
// playground uses.
import * as _compiler from "@unworklet/compiler";
import * as _examples from "@unworklet/examples";
(window as any).__unworklet_compiler = _compiler;
(window as any).__unworklet_examples = _examples;

const routes = [
  { path: "/", name: "home", component: Home, meta: { title: "Home" } },
  { path: "/01-gain", name: "gain", component: StereoGain, meta: { title: "Stereo Gain + Meter" } },
  { path: "/02-eq", name: "eq", component: ThreeBandEQ, meta: { title: "3-Band Biquad EQ" } },
  { path: "/03-lineareq", name: "lineareq", component: LinearPhaseEQ, meta: { title: "Linear-Phase EQ (FIR)" } },
  { path: "/04-limiter", name: "limiter", component: LookaheadLimiter, meta: { title: "Lookahead Limiter" } },
  { path: "/05-granular", name: "granular", component: GranularSampler, meta: { title: "Granular Sampler" } },
  { path: "/06-arp", name: "arp", component: Arpeggiator, meta: { title: "MIDI Arpeggiator" } },
  { path: "/07-reverb", name: "reverb", component: ConvolutionReverb, meta: { title: "Convolution Reverb" } },
  { path: "/08-poly", name: "poly", component: PolySynth, meta: { title: "Polyphonic Synth" } },
  { path: "/09-delay", name: "delay", component: FeedbackDelay, meta: { title: "Feedback Delay" } },
  { path: "/10-chorus", name: "chorus", component: Chorus, meta: { title: "Stereo Chorus" } },
  { path: "/11-dist", name: "dist", component: Distortion, meta: { title: "Distortion" } },
  { path: "/12-drum", name: "drum", component: DrumSampler, meta: { title: "Drum Sampler" } },
  { path: "/13-comp", name: "comp", component: Compressor, meta: { title: "Compressor" } },
  { path: "/14-fm", name: "fm", component: FmSynth, meta: { title: "FM Synth" } },
  { path: "/15-playground", name: "codeplayground", component: CodePlayground, meta: { title: "Code Playground" } },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.afterEach((to) => {
  const t = (to.meta?.title as string) || "";
  document.title = t ? `${t} · unworklet` : "unworklet";
});

createApp(App).use(router).mount("#app");
