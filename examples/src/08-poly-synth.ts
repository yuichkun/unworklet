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
  num,
  select,
  flushDenormals,
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

    const aCoef = num(1).sub(num(-1).div(attackS.mul(sr)).exp());
    const rCoef = num(1).sub(num(-1).div(releaseS.mul(sr)).exp());

    const target = select(gate, velocity, num(0));
    const coef = select(gate, aCoef, rCoef);
    // One-pole release with rCoef close to 1 — flush subnormals so that a
    // released voice doesn't keep the audio thread chewing on denormals.
    const e = flushDenormals(env.load().add(coef.mul(target.sub(env.load()))));
    env.store(e);

    const inc = noteHz.div(sr);
    const p = phase.load().add(inc);
    phase.store(select(p.gt(1), p.sub(1), p));

    return p.mul(2 * Math.PI).sin().mul(e);
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
        // note / velocity are raw JS numbers from the MIDI payload — wrap
        // with num() to lift into the graph for chain arithmetic.
        const v = allocCursor.load();
        const velNorm = num(velocity).mul(1 / 127);
        for (let s = 0; s < NUM_VOICES; s++) {
          const isMe = v.eq(s);
          voiceNote[s]!.store(select(isMe, note, voiceNote[s]!.load()));
          voiceVel[s]!.store(select(isMe, velNorm, voiceVel[s]!.load()));
          voiceGate[s]!.store(select(isMe, true, voiceGate[s]!.load()));
        }
        allocCursor.store(v.add(1).mod(NUM_VOICES));

        notePlayed.emitIf(true, {
          atSample,
          note,
          voice: v as unknown as number,
          velocity: velNorm as unknown as number,
        });
      });

      midi.onEvent("noteOff", ({ note }) => {
        for (let s = 0; s < NUM_VOICES; s++) {
          voiceGate[s]!.store(
            select(voiceNote[s]!.load().eq(note), false, voiceGate[s]!.load()),
          );
        }
      });

      const aCoef = 0.05;
      const rCoef = num(1).sub(num(-1).div(num(0.2).mul(ctx.sampleRate)).exp());

      const wpStart = wavePtr.load();

      forSample((i) => {
        const scPeak = sidechain.at(0, i).abs().max(sidechain.at(1, i).abs());
        const scC = select(scPeak.gt(scEnv.load()), aCoef, rCoef);
        scEnv.store(scEnv.load().add(scC.mul(scPeak.sub(scEnv.load()))));

        const duck = num(1).sub(duckAmount.at(0).mul(scEnv.load()));

        let mix: Node<"f32"> = num(0);
        for (let s = 0; s < NUM_VOICES; s++) {
          const note = voiceNote[s]!.load();
          const vel = voiceVel[s]!.load();
          const gate = voiceGate[s]!.load();
          const hz = note.sub(69).mul(Math.LN2 / 12).exp().mul(440);
          mix = mix.add(
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

        const sig = mix.mul(masterVol.at(i)).mul(duck);
        out.left.set(i, sig);
        out.right.set(i, sig);

        const wp = wpStart.add(i).mod(1024);
        waveform.write(wp, sig);
      });

      wavePtr.store(wpStart.add(128).mod(1024));

      let count: Node<"i32"> = num(0) as unknown as Node<"i32">;
      for (let s = 0; s < NUM_VOICES; s++) {
        count = count.add(select(voiceGate[s]!.load(), 1, 0));
      }
      activeVoices.store(count);
    },
  };
});
