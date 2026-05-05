import {
  defineProcessor,
  defineSubgraph,
  audioInput,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  midiInput,
  event,
  add,
  sub,
  mul,
  div,
  mod,
  max,
  abs,
  sin,
  exp,
  gt,
  eq,
  select,
  type Node,
} from "@unworklet/core";

const NUM_VOICES = 8;

const synthVoice = defineSubgraph(
  (
    noteHz: Node<"f32">,
    velocity: Node<"f32">,
    gate: Node<"bool">,
    attackS: Node<"f32">,
    releaseS: Node<"f32">,
    sr: number,
  ) => {
    const phase = state.f32(0);
    const env = state.f32(0);

    const aCoef = sub(1, exp(div(-1, mul(attackS, sr))));
    const rCoef = sub(1, exp(div(-1, mul(releaseS, sr))));

    const target = select(gate, velocity, mul(0, 0));
    const coef = select(gate, aCoef, rCoef);
    const e = add(env.load(), mul(coef, sub(target, env.load())));
    env.store(e);

    const inc = div(noteHz, sr);
    const p = add(phase.load(), inc);
    phase.store(select(gt(p, 1), sub(p, 1), p));

    return mul(sin(mul(p, 2 * Math.PI)), e);
  },
);

export const polySynth = defineProcessor((ctx) => {
  const sidechain = audioInput({ channels: 2, name: "sidechain" });
  const out = audioOutput({ channels: 2, name: "main" });

  const attack = param({
    default: 0.01,
    min: 0.001,
    max: 1,
    automationRate: "k-rate",
    name: "attack",
  });
  const release = param({
    default: 0.3,
    min: 0.01,
    max: 4,
    automationRate: "k-rate",
    name: "release",
  });
  const masterVol = param({
    default: 0.7,
    min: 0,
    max: 1,
    automationRate: "a-rate",
    name: "masterVol",
  });
  const duckAmount = param({
    default: 0.5,
    min: 0,
    max: 1,
    automationRate: "k-rate",
    name: "duckAmount",
  });

  const voiceNote: ReturnType<typeof state.i32>[] = [];
  const voiceVel: ReturnType<typeof state.f32>[] = [];
  const voiceGate: ReturnType<typeof state.bool>[] = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    voiceNote.push(state.i32(60, { name: `vn_${v}` }));
    voiceVel.push(state.f32(0, { name: `vv_${v}` }));
    voiceGate.push(state.bool(false, { name: `vg_${v}` }));
  }
  const allocCursor = state.i32(0, { name: "allocCursor" });
  const scEnv = state.f32(0, { name: "scEnv" });

  const waveform = buffer.f32({
    size: 1024,
    name: "waveform",
    publish: { rateFps: 30 },
  });
  const wavePtr = state.i32(0, { name: "wavePtr" });
  const activeVoices = state.i32(0, { name: "activeVoices", publish: { rateFps: 15 } });

  const notePlayed = event<{ note: number; voice: number; velocity: number }>({
    name: "notePlayed",
  });

  const midi = midiInput({ name: "midi" });

  return {
    process: () => {
      midi.onEvent("noteOn", ({ note, velocity, atSample }) => {
        const v = allocCursor.load();
        for (let s = 0; s < NUM_VOICES; s++) {
          const isMe = eq(v, s);
          voiceNote[s]!.store(select(isMe, note, voiceNote[s]!.load()));
          voiceVel[s]!.store(select(isMe, mul(velocity, 1 / 127), voiceVel[s]!.load()));
          voiceGate[s]!.store(select(isMe, true, voiceGate[s]!.load()));
        }
        allocCursor.store(mod(add(v, 1), NUM_VOICES));

        notePlayed.emitIf(true, {
          atSample,
          note,
          voice: v as unknown as number,
          velocity: mul(velocity, 1 / 127) as unknown as number,
        });
      });

      midi.onEvent("noteOff", ({ note }) => {
        for (let s = 0; s < NUM_VOICES; s++) {
          voiceGate[s]!.store(select(eq(voiceNote[s]!.load(), note), false, voiceGate[s]!.load()));
        }
      });

      const aCoef = 0.05;
      const rCoef = sub(1, exp(div(-1, mul(0.2, ctx.sampleRate))));

      const wpStart = wavePtr.load();

      forSample((i) => {
        const scPeak = max(abs(sidechain.at(0, i)), abs(sidechain.at(1, i)));
        const scC = select(gt(scPeak, scEnv.load()), aCoef, rCoef);
        scEnv.store(add(scEnv.load(), mul(scC, sub(scPeak, scEnv.load()))));

        const duck = sub(1, mul(duckAmount.at(0), scEnv.load()));

        let mix: Node<"f32"> = mul(0, 0);
        for (let s = 0; s < NUM_VOICES; s++) {
          const note = voiceNote[s]!.load();
          const vel = voiceVel[s]!.load();
          const gate = voiceGate[s]!.load();
          const hz = mul(440, exp(mul(sub(note, 69), Math.LN2 / 12)));
          mix = add(
            mix,
            synthVoice(
              hz,
              vel,
              gate as unknown as Node<"bool">,
              attack.at(0),
              release.at(0),
              ctx.sampleRate,
            ),
          );
        }

        const sig = mul(mul(mix, masterVol.at(i)), duck);
        out.set(0, i, sig);
        out.set(1, i, sig);

        const wp = mod(add(wpStart, i), 1024);
        waveform.write(wp, sig);
      });

      wavePtr.store(mod(add(wpStart, 128), 1024));

      let count: Node<"i32"> = 0 as unknown as Node<"i32">;
      for (let s = 0; s < NUM_VOICES; s++) {
        count = add(count, select(voiceGate[s]!.load(), 1, 0));
      }
      activeVoices.store(count);
    },
  };
});
