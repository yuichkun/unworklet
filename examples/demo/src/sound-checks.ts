import { examples } from "./examples.ts";

export const SOUND_CHECK_SAMPLE_RATE = 48000;
export const SOUND_CHECK_FRAMES = 48000;

export type SoundCheckDrive =
  | { kind: "none" }
  | { kind: "sweep"; port: string; channels: 1 | 2 }
  | { kind: "notes"; port: string; notes: number[] }
  | { kind: "param-ramp"; param: string; to: number }
  | { kind: "events"; events: { name: string; payload: unknown; atSample: number }[] };

export type SoundCheck = {
  slug: string;
  group: "operation" | "example";
  exercises: string;
  source: string;
  drive: SoundCheckDrive;
};

export function sweep(): Float32Array {
  const out = new Float32Array(SOUND_CHECK_FRAMES);
  const f0 = 55;
  const f1 = 4000;
  const seconds = SOUND_CHECK_FRAMES / SOUND_CHECK_SAMPLE_RATE;
  const k = Math.log(f1 / f0);
  for (let n = 0; n < out.length; n++) {
    const t = n / SOUND_CHECK_SAMPLE_RATE;
    out[n] = 0.5 * Math.sin(((2 * Math.PI * f0 * seconds) / k) * (Math.exp((k * t) / seconds) - 1));
  }
  return out;
}

const phasor = (expr: string): string => `const out   = audioOutput({ channels: 1, name: "main" });
const phase = state.f32(0).named();

process(() => {
  forSample((i) => {
    phase.write((phase + 220 / ctx.sampleRate) % 1);
    const p = phase;
    out.ch(0)[i] = ${expr};
  });
});
`;
export const soundChecks: SoundCheck[] = [
  {
    slug: "add",
    group: "operation",
    exercises: "Infix +",
    source: phasor("(p + 0.5) % 1 - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "sub",
    group: "operation",
    exercises: "Infix -",
    source: phasor("0.5 - p"),
    drive: { kind: "none" },
  },
  {
    slug: "mul",
    group: "operation",
    exercises: "Infix *",
    source: phasor("(p * 2 - 1) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "div",
    group: "operation",
    exercises: "Infix /",
    source: phasor("(p * 2 - 1) / 2"),
    drive: { kind: "none" },
  },
  {
    slug: "mod",
    group: "operation",
    exercises: "Infix %",
    source: phasor("(p * 3) % 1 - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "neg",
    group: "operation",
    exercises: "Unary -",
    source: phasor("-(p - 0.5)"),
    drive: { kind: "none" },
  },
  {
    slug: "lt",
    group: "operation",
    exercises: "< with ?:",
    source: phasor("p < 0.5 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "gt",
    group: "operation",
    exercises: "> with ?:",
    source: phasor("p > 0.75 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "lte",
    group: "operation",
    exercises: "<= with ?:",
    source: phasor("p <= 0.25 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "gte",
    group: "operation",
    exercises: ">= with ?:",
    source: phasor("p >= 0.9 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "eq",
    group: "operation",
    exercises: "== on f32",
    source: phasor("floor(p * 4) == 2 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "neq",
    group: "operation",
    exercises: "!= on f32",
    source: phasor("floor(p * 4) != 2 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "and",
    group: "operation",
    exercises: "&& on bool",
    source: phasor("p > 0.25 && p < 0.5 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "or",
    group: "operation",
    exercises: "|| on bool",
    source: phasor("p < 0.1 || p > 0.6 ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "not",
    group: "operation",
    exercises: "Unary !",
    source: phasor("!(p < 0.3) ? 0.5 : -0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "sin",
    group: "operation",
    exercises: "sin",
    source: phasor("sin(p * (Math.PI * 2)) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "cos",
    group: "operation",
    exercises: "cos",
    source: phasor("cos(p * (Math.PI * 2)) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "tan",
    group: "operation",
    exercises: "tan",
    source: phasor("clamp(tan((p - 0.5) * 2.8), -1, 1) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "tanh",
    group: "operation",
    exercises: "tanh",
    source: phasor("tanh((p * 2 - 1) * 4) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "exp",
    group: "operation",
    exercises: "exp",
    source: phasor("exp(-p * 6) - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "log",
    group: "operation",
    exercises: "log",
    source: phasor("log(1 + p * 9) / Math.LN10 - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "pow-integral",
    group: "operation",
    exercises: "** with an integral exponent",
    source: phasor("(p * 2 - 1) ** 3 * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "pow-fractional",
    group: "operation",
    exercises: "** with a fractional exponent",
    source: phasor("p ** 0.3 - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "sqrt",
    group: "operation",
    exercises: "sqrt",
    source: phasor("sqrt(p) - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "floor",
    group: "operation",
    exercises: "floor",
    source: phasor("floor((p * 2 - 1) * 4) / 8"),
    drive: { kind: "none" },
  },
  {
    slug: "ceil",
    group: "operation",
    exercises: "ceil",
    source: phasor("ceil((p * 2 - 1) * 4) / 8"),
    drive: { kind: "none" },
  },
  {
    slug: "frac",
    group: "operation",
    exercises: "frac",
    source: phasor("frac(p * 2) - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "abs",
    group: "operation",
    exercises: "abs",
    source: phasor("abs(p * 2 - 1) - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "min",
    group: "operation",
    exercises: "min",
    source: phasor("min(p * 2 - 1, 0.2) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "max",
    group: "operation",
    exercises: "max",
    source: phasor("max(p * 2 - 1, -0.2) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "clamp",
    group: "operation",
    exercises: "clamp",
    source: phasor("clamp((p * 2 - 1) * 3, -1, 1) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "i32-arithmetic",
    group: "operation",
    exercises: "i32 multiply and modulo, i32(x) / f32(n) conversion",
    source: phasor("f32((i32(p * 16) * 5) % 16) / 16 - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "i32-division",
    group: "operation",
    exercises: "i32 truncating division",
    source: phasor("f32(i32(p * 64) / 8) / 8 - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "f64",
    group: "operation",
    exercises: "f64 arithmetic and conversion",
    source: phasor("f32(f64(p) * 2 - 1) * 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "bool-to-f32",
    group: "operation",
    exercises: "f32(bool) conversion",
    source: phasor("f32(p < 0.5) - 0.5"),
    drive: { kind: "none" },
  },
  {
    slug: "state-i32",
    group: "operation",
    exercises: "state.i32 counter",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst count = state.i32(0).named();\n\nprocess(() => {\n  forSample((i) => {\n    count.write((count + 1) % 100);\n    out.ch(0)[i] = count < 50 ? 0.5 : -0.5;\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "state-bool",
    group: "operation",
    exercises: "state.bool toggle",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst phase = state.f32(0).named();\nconst high  = state.bool(false).named();\n\nprocess(() => {\n  forSample((i) => {\n    phase.write((phase + 330 / ctx.sampleRate) % 1);\n    high.write(phase < 0.5);\n    out.ch(0)[i] = high ? 0.5 : -0.5;\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "buffer-delay",
    group: "operation",
    exercises: "state.buffer.f32 write and read (comb filter)",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst phase = state.f32(0).named();\nconst line  = state.buffer.f32({ size: 64 }).named("line");\nconst head  = state.i32(0).named();\n\nprocess(() => {\n  forSample((i) => {\n    phase.write((phase + 220 / ctx.sampleRate) % 1);\n    const saw = phase * 2 - 1;\n    const w = head;\n    line[w] = saw;\n    out.ch(0)[i] = (saw + line[(w + 1) % 64]) * 0.25;\n    head.write((w + 1) % 64);\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "buffer-interpolated",
    group: "operation",
    exercises: "state.buffer.f32 .readInterpolated",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst table = state.buffer.f32({ size: 8 }).named("table");\nconst pos   = state.f32(0).named();\n\nprocess(() => {\n  forSample((i) => {\n    table[i % 8] = f32(i % 8) / 4 - 1;\n    pos.write((pos + 0.02) % 7);\n    out.ch(0)[i] = table.readInterpolated(pos) * 0.5;\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "param-a-rate",
    group: "operation",
    exercises: "a-rate param sampled per sample (rendered with a gain ramp)",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst phase = state.f32(0).named();\nconst level = param.f32({ default: 0.5, min: 0, max: 1, automationRate: "a-rate" }).named();\n\nprocess(() => {\n  forSample((i) => {\n    phase.write((phase + 220 / ctx.sampleRate) % 1);\n    out.ch(0)[i] = (phase * 2 - 1) * level[i];\n  });\n});\n',
    drive: { kind: "param-ramp", param: "level", to: 0.5 },
  },
  {
    slug: "param-k-rate",
    group: "operation",
    exercises: "k-rate param at its default",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst phase = state.f32(0).named();\nconst level = param.f32({ default: 0.4, min: 0, max: 1, automationRate: "k-rate" }).named();\n\nprocess(() => {\n  forSample((i) => {\n    phase.write((phase + 220 / ctx.sampleRate) % 1);\n    out.ch(0)[i] = (phase * 2 - 1) * level[i];\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "noise",
    group: "operation",
    exercises: "noiseSource with a fixed seed",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst noise = noiseSource({ seed: 1 });\n\nprocess(() => {\n  forSample((i) => {\n    out.ch(0)[i] = noise.next() * 0.25;\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "subgraph-prev",
    group: "operation",
    exercises: "defineSubgraph / instantiate with $prev (one-pole lowpass on noise)",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst noise = noiseSource({ seed: 2 });\nconst onepole = defineSubgraph((k: Node<"f32">) => ({\n  process: (x: Node<"f32">) => k * x + (1 - k) * $prev,\n}));\nconst lp = instantiate(onepole, f32(0.05), { name: "lp" });\n\nprocess(() => {\n  forSample((i) => {\n    out.ch(0)[i] = lp.process(noise.next()) * 2;\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "every-n-samples",
    group: "operation",
    exercises: "everyNSamples (sample and hold of noise)",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst noise = noiseSource({ seed: 3 });\nconst held  = state.f32(0).named();\n\nprocess(() => {\n  forSample((i, everyNSamples) => {\n    everyNSamples(480, () => {\n      held.write(noise.next() * 0.5);\n    });\n    out.ch(0)[i] = held;\n  });\n});\n',
    drive: { kind: "none" },
  },
  {
    slug: "event-from-main",
    group: "operation",
    exercises: "event from main changing pitch (rendered with three events)",
    source:
      'const out   = audioOutput({ channels: 1, name: "main" });\nconst pitch = event<{ hz: number }>({ from: "main", name: "pitch" });\nconst hz    = state.f32(220).named();\nconst phase = state.f32(0).named();\n\nprocess(() => {\n  pitch.onReceive(({ hz: next }) => hz.write(next));\n  forSample((i) => {\n    phase.write((phase + hz / ctx.sampleRate) % 1);\n    out.ch(0)[i] = sin(phase * (Math.PI * 2)) * 0.5;\n  });\n});\n',
    drive: {
      kind: "events",
      events: [
        { name: "pitch", payload: { hz: 330 }, atSample: 12000 },
        { name: "pitch", payload: { hz: 440 }, atSample: 24000 },
        { name: "pitch", payload: { hz: 550 }, atSample: 36000 },
      ],
    },
  },
  {
    slug: "distortion",
    group: "example",
    exercises: examples.find((e) => e.slug === "distortion")!.title,
    source: examples.find((e) => e.slug === "distortion")!.source,
    drive: { kind: "sweep", port: "main", channels: 2 },
  },
  {
    slug: "lowpass",
    group: "example",
    exercises: examples.find((e) => e.slug === "lowpass")!.title,
    source: examples.find((e) => e.slug === "lowpass")!.source,
    drive: { kind: "sweep", port: "main", channels: 2 },
  },
  {
    slug: "tremolo",
    group: "example",
    exercises: examples.find((e) => e.slug === "tremolo")!.title,
    source: examples.find((e) => e.slug === "tremolo")!.source,
    drive: { kind: "sweep", port: "main", channels: 2 },
  },
  {
    slug: "bitcrush",
    group: "example",
    exercises: examples.find((e) => e.slug === "bitcrush")!.title,
    source: examples.find((e) => e.slug === "bitcrush")!.source,
    drive: { kind: "sweep", port: "main", channels: 2 },
  },
  {
    slug: "gain-meter",
    group: "example",
    exercises: examples.find((e) => e.slug === "gain-meter")!.title,
    source: examples.find((e) => e.slug === "gain-meter")!.source,
    drive: { kind: "sweep", port: "main", channels: 2 },
  },
  {
    slug: "eq3",
    group: "example",
    exercises: examples.find((e) => e.slug === "eq3")!.title,
    source: examples.find((e) => e.slug === "eq3")!.source,
    drive: { kind: "sweep", port: "main", channels: 2 },
  },
  {
    slug: "limiter",
    group: "example",
    exercises: examples.find((e) => e.slug === "limiter")!.title,
    source: examples.find((e) => e.slug === "limiter")!.source,
    drive: { kind: "sweep", port: "main", channels: 1 },
  },
  {
    slug: "reverb",
    group: "example",
    exercises: examples.find((e) => e.slug === "reverb")!.title,
    source: examples.find((e) => e.slug === "reverb")!.source,
    drive: { kind: "sweep", port: "main", channels: 1 },
  },
  {
    slug: "linear-phase",
    group: "example",
    exercises: examples.find((e) => e.slug === "linear-phase")!.title,
    source: examples.find((e) => e.slug === "linear-phase")!.source,
    drive: { kind: "sweep", port: "main", channels: 1 },
  },
  {
    slug: "synth",
    group: "example",
    exercises: examples.find((e) => e.slug === "synth")!.title,
    source: examples.find((e) => e.slug === "synth")!.source,
    drive: { kind: "notes", port: "keys", notes: [60] },
  },
  {
    slug: "arp",
    group: "example",
    exercises: examples.find((e) => e.slug === "arp")!.title,
    source: examples.find((e) => e.slug === "arp")!.source,
    drive: { kind: "notes", port: "keys", notes: [60] },
  },
  {
    slug: "polysynth",
    group: "example",
    exercises: examples.find((e) => e.slug === "polysynth")!.title,
    source: examples.find((e) => e.slug === "polysynth")!.source,
    drive: { kind: "notes", port: "keys", notes: [60, 64, 67] },
  },
  {
    slug: "granular",
    group: "example",
    exercises: examples.find((e) => e.slug === "granular")!.title,
    source: examples.find((e) => e.slug === "granular")!.source,
    drive: { kind: "notes", port: "keys", notes: [60] },
  },
  {
    slug: "harmonizer",
    group: "example",
    exercises: examples.find((e) => e.slug === "harmonizer")!.title,
    source: examples.find((e) => e.slug === "harmonizer")!.source,
    drive: { kind: "notes", port: "keys", notes: [60] },
  },
];
