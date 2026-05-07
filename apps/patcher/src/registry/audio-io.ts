import { register } from "./store";

// dac~ — sends audio to the speakers. Mono or stereo. Inlets are the channels.
register({
  type: "dac~",
  category: "audio-io",
  description: "Audio output to speakers (mono or stereo).",
  inlets: [
    { kind: "audio", label: "L" },
    { kind: "audio", label: "R" },
  ],
  outlets: [],
  ioSpec: { direction: "out", channels: 2, name: "main" },
  build: () => [],
  component: "AudioNodeView",
});

// adc~ — receives audio from the soundcard / mic. Outlets are the channels.
register({
  type: "adc~",
  category: "audio-io",
  description: "Audio input from microphone / line in.",
  inlets: [],
  outlets: [
    { kind: "audio", label: "L" },
    { kind: "audio", label: "R" },
  ],
  ioSpec: { direction: "in", channels: 2, name: "main" },
  build: () => [],
  component: "AudioNodeView",
});
