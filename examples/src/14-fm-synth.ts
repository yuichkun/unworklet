import {
  defineProcessor,
  defineSubgraph,
  audioOutput,
  param,
  state,
  forSample,
  midiInput,
  event,
  add,
  sub,
  mul,
  div,
  sin,
  exp,
  eq,
  gt,
  mod,
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

    const aCoef = sub(1, exp(div(-1, mul(aS, sr))));
    const rCoef = sub(1, exp(div(-1, mul(rS, sr))));
    const target = select(gate, velocity, mul(0, 0));
    const coef = select(gate, aCoef, rCoef);
    const e = add(env.load(), mul(coef, sub(target, env.load())));
    env.store(e);

    const mInc = div(mul(carrierHz, modRatio), sr);
    const mp = add(mPhase.load(), mInc);
    mPhase.store(select(gt(mp, 1), sub(mp, 1), mp));
    const modSig = sin(mul(mp, 2 * Math.PI));

    const cInc = div(carrierHz, sr);
    const cp = add(cPhase.load(), cInc);
    cPhase.store(select(gt(cp, 1), sub(cp, 1), cp));
    const sigPhase = add(mul(cp, 2 * Math.PI), mul(modIndex, modSig));
    return mul(sin(sigPhase), e);
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
        for (let s = 0; s < NUM_VOICES; s++) {
          const isMe = eq(v, s);
          voiceNote[s]!.store(select(isMe, note, voiceNote[s]!.load()));
          voiceVel[s]!.store(select(isMe, velocity / 127, voiceVel[s]!.load()));
          voiceGate[s]!.store(select(isMe, true, voiceGate[s]!.load()));
        }
        allocCursor.store(mod(add(v, 1), NUM_VOICES));
        notePlayed.emitIf(true, { atSample, note, voice: v as unknown as number, velocity: velocity / 127 });
      });

      midi.onEvent("noteOff", ({ note }) => {
        for (let s = 0; s < NUM_VOICES; s++) {
          voiceGate[s]!.store(select(eq(voiceNote[s]!.load(), note), false, voiceGate[s]!.load()));
        }
      });

      const ratio = modRatio.at(0);

      forSample((i) => {
        const idx = modIndex.at(i);
        let mix: Node<"f32"> = mul(0, 0);
        for (let s = 0; s < NUM_VOICES; s++) {
          const note = voiceNote[s]!.load();
          const vel = voiceVel[s]!.load();
          const gate = voiceGate[s]!.load();
          const hz = mul(440, exp(mul(sub(note, 69), Math.LN2 / 12)));
          mix = add(
            mix,
            fmVoice(hz, ratio, idx, vel, gate as unknown as Node<"bool">, attack.at(0), release.at(0), ctx.sampleRate),
          );
        }
        const sig = mul(mix, masterVol.at(i));
        out.set(0, i, sig);
        out.set(1, i, sig);
      });

      let count: Node<"i32"> = 0 as unknown as Node<"i32">;
      for (let s = 0; s < NUM_VOICES; s++) {
        count = add(count, select(voiceGate[s]!.load(), 1, 0));
      }
      activeVoices.store(count);
    },
  };
});
