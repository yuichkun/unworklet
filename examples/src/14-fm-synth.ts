import {
  defineProcessor,
  defineSubgraph,
  audioOutput,
  param,
  state,
  forSample,
  midiInput,
  event,
  num,
  select,
  type Node,
} from "@unworklet/core";

// 6-voice 2-operator FM synth.
const NUM_VOICES = 6;

const fmVoice = defineSubgraph(
  (
    carrierHz: Node<"f32">,
    modRatio: Node<"f32">,
    modIndex: Node<"f32">,
    velocity: Node<"f32">,
    gate: Node<"bool">,
    aS: Node<"f32">,
    rS: Node<"f32">,
    sr: number,
  ) => {
    const cPhase = state.f32(0);
    const mPhase = state.f32(0);
    const env = state.f32(0);

    const aCoef = num(1).sub(num(-1).div(aS.mul(sr)).exp());
    const rCoef = num(1).sub(num(-1).div(rS.mul(sr)).exp());
    const target = select(gate, velocity, num(0));
    const coef = select(gate, aCoef, rCoef);
    const e = env.load().add(coef.mul(target.sub(env.load())));
    env.store(e);

    const mInc = carrierHz.mul(modRatio).div(sr);
    const mp = mPhase.load().add(mInc);
    mPhase.store(select(mp.gt(1), mp.sub(1), mp));
    const modSig = mp.mul(2 * Math.PI).sin();

    const cInc = carrierHz.div(sr);
    const cp = cPhase.load().add(cInc);
    cPhase.store(select(cp.gt(1), cp.sub(1), cp));
    const sigPhase = cp.mul(2 * Math.PI).add(modIndex.mul(modSig));
    return sigPhase.sin().mul(e);
  },
);

export const fmSynth = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 2, name: "main" });

  const modRatio = param({
    default: 2,
    min: 0.25,
    max: 16,
    automationRate: "k-rate",
    name: "modRatio",
  });
  const modIndex = param({
    default: 1.5,
    min: 0,
    max: 12,
    automationRate: "a-rate",
    name: "modIndex",
  });
  const attack = param({
    default: 0.005,
    min: 0.001,
    max: 1,
    automationRate: "k-rate",
    name: "attack",
  });
  const release = param({
    default: 0.4,
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

  const voiceNote: ReturnType<typeof state.i32>[] = [];
  const voiceVel: ReturnType<typeof state.f32>[] = [];
  const voiceGate: ReturnType<typeof state.bool>[] = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    voiceNote.push(state.i32(60, { name: `vn_${v}` }));
    voiceVel.push(state.f32(0, { name: `vv_${v}` }));
    voiceGate.push(state.bool(false, { name: `vg_${v}` }));
  }
  const allocCursor = state.i32(0, { name: "allocCursor" });

  const activeVoices = state.i32(0, { name: "activeVoices", publish: { rateFps: 30 } });
  const notePlayed = event<{ note: number; voice: number; velocity: number }>({
    name: "notePlayed",
  });
  const midi = midiInput({ name: "midi" });

  return {
    process: () => {
      midi.onEvent("noteOn", ({ note, velocity, atSample }) => {
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

      const ratio = modRatio.at(0);

      forSample((i) => {
        const idx = modIndex.at(i);
        let mix: Node<"f32"> = num(0);
        for (let s = 0; s < NUM_VOICES; s++) {
          const note = voiceNote[s]!.load();
          const vel = voiceVel[s]!.load();
          const gate = voiceGate[s]!.load();
          const hz = note.sub(69).mul(Math.LN2 / 12).exp().mul(440);
          mix = mix.add(
            fmVoice(hz, ratio, idx, vel, gate as unknown as Node<"bool">, attack.at(0), release.at(0), ctx.sampleRate),
          );
        }
        const sig = mix.mul(masterVol.at(i));
        out.left.set(i, sig);
        out.right.set(i, sig);
      });

      let count: Node<"i32"> = num(0) as unknown as Node<"i32">;
      for (let s = 0; s < NUM_VOICES; s++) {
        count = count.add(select(voiceGate[s]!.load(), 1, 0));
      }
      activeVoices.store(count);
    },
  };
});
