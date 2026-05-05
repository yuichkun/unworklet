import {
  defineProcessor,
  audioOutput,
  param,
  state,
  buffer,
  forSample,
  midiInput,
  message,
  event,
  add,
  sub,
  mul,
  type Node,
} from "@unworklet/core";

// 8-pad drum sampler. Each pad has its own sample buffer (uploaded via message)
// and a single voice. MIDI notes 36..43 trigger pads 0..7.
const NUM_PADS = 8;
const MAX_SAMPLE_LEN = 48000 * 4; // 4 seconds per pad

export const drumSampler = defineProcessor(() => {
  const out = audioOutput({ channels: 2, name: "main" });

  const masterVol = param({
    default: 0.8,
    min: 0,
    max: 2,
    automationRate: "a-rate",
    name: "masterVol",
  });

  const pads: ReturnType<typeof buffer.f32>[] = [];
  const padLens: ReturnType<typeof state.i32>[] = [];
  const padPos: ReturnType<typeof state.i32>[] = [];
  const padGate: ReturnType<typeof state.bool>[] = [];
  const padVel: ReturnType<typeof state.f32>[] = [];
  for (let p = 0; p < NUM_PADS; p++) {
    pads.push(buffer.f32({ size: MAX_SAMPLE_LEN, name: `pad_${p}`, snapshot: "persistent" }));
    padLens.push(state.i32(0, { name: `padLen_${p}` }));
    padPos.push(state.i32(0, { name: `padPos_${p}` }));
    padGate.push(state.bool(false, { name: `padGate_${p}` }));
    padVel.push(state.f32(0, { name: `padVel_${p}` }));
  }

  const uploadPad = message<{ pad: number; samples: Float32Array }>({ name: "uploadPad" });
  const triggerPad = message<{ pad: number; velocity: number }>({ name: "triggerPad" });

  const padTriggered = event<{ pad: number; velocity: number }>({ name: "padTriggered" });

  const midi = midiInput({ name: "midi" });

  const playingMask = state.i32(0, { name: "playingMask", publish: { rateFps: 30 } });

  return {
    process: () => {
      uploadPad.onReceive(({ pad, samples }) => {
        if (pad < 0 || pad >= NUM_PADS) return;
        const len = Math.min(samples.length, MAX_SAMPLE_LEN);
        const buf = pads[pad]!;
        for (let i = 0; i < len; i++) buf.write(i, samples[i]!);
        for (let i = len; i < MAX_SAMPLE_LEN; i++) buf.write(i, 0);
        padLens[pad]!.store(len);
      });

      triggerPad.onReceive(({ pad, velocity }) => {
        if (pad < 0 || pad >= NUM_PADS) return;
        if ((padLens[pad]!.load() as unknown as number) === 0) return;
        padPos[pad]!.store(0);
        padGate[pad]!.store(true);
        padVel[pad]!.store(velocity);
        padTriggered.emitIf(true, { atSample: 0, pad, velocity });
      });

      midi.onEvent("noteOn", ({ note, velocity, atSample }) => {
        const pad = note - 36;
        if (pad < 0 || pad >= NUM_PADS) return;
        if ((padLens[pad]!.load() as unknown as number) === 0) return;
        padPos[pad]!.store(0);
        padGate[pad]!.store(true);
        padVel[pad]!.store((velocity as unknown as number) / 127);
        padTriggered.emitIf(true, { atSample, pad, velocity: (velocity as unknown as number) / 127 });
      });

      forSample((i) => {
        let mix = 0;
        let mask = 0;
        for (let p = 0; p < NUM_PADS; p++) {
          const gate = padGate[p]!.load() as unknown as boolean;
          if (!gate) continue;
          const pos = padPos[p]!.load() as unknown as number;
          const len = padLens[p]!.load() as unknown as number;
          if (pos >= len) {
            padGate[p]!.store(false);
            continue;
          }
          const v = pads[p]!.read(pos) as unknown as number;
          const vel = padVel[p]!.load() as unknown as number;
          mix += v * vel;
          padPos[p]!.store(pos + 1);
          mask |= 1 << p;
        }
        const sig = mix * (masterVol.at(i) as unknown as number);
        out.set(0, i, sig as unknown as Node<"f32">);
        out.set(1, i, sig as unknown as Node<"f32">);
        playingMask.store(mask as unknown as number);
      });
    },
  };
});
