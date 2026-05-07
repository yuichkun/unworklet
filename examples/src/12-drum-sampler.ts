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
  num,
  select,
  type Node,
} from "@unworklet/core";

// 8-pad drum sampler. Each pad has its own sample buffer (uploaded via message)
// and a single voice. MIDI notes 36..43 trigger pads 0..7.
const NUM_PADS = 8;
const MAX_SAMPLE_LEN = 48000 * 4;

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

  const uploadPad = message<{ pad: number; samples: Float32Array }>({
    name: "uploadPad",
    capacity: 8,
    payload: { samples: { type: "f32", maxLength: MAX_SAMPLE_LEN } },
  });
  const triggerPad = message<{ pad: number; velocity: number }>({ name: "triggerPad" });

  const padTriggered = event<{ pad: number; velocity: number }>({ name: "padTriggered" });

  const midi = midiInput({ name: "midi" });

  return {
    process: () => {
      uploadPad.onReceive(({ pad, samples }) => {
        // Static fan-out: emit a guarded copy per pad. samples.copyToIf
        // wraps the memory.copy in `if (cond)` in WASM so non-matching
        // pads truly no-op (no spurious destination address evaluation).
        const len = samples.length();
        // pad is a raw JS number from the message payload; lift before chaining.
        const padNode = num(pad).toI32();
        for (let p = 0; p < NUM_PADS; p++) {
          const isMe = padNode.eq(p);
          samples.copyToIf(isMe, pads[p]!, 0, len);
          padLens[p]!.store(select(isMe, len, padLens[p]!.load()));
        }
      });

      triggerPad.onReceive(({ pad, velocity }) => {
        const padNode = num(pad).toI32();
        for (let p = 0; p < NUM_PADS; p++) {
          const isMe = padNode.eq(p);
          padPos[p]!.store(select(isMe, 0, padPos[p]!.load()));
          padGate[p]!.store(select(isMe, true, padGate[p]!.load()));
          padVel[p]!.store(select(isMe, velocity, padVel[p]!.load()));
        }
      });

      midi.onEvent("noteOn", ({ note, velocity, atSample }) => {
        const pad = num(note).sub(36).toI32();
        const velNorm = num(velocity).mul(1 / 127);
        for (let p = 0; p < NUM_PADS; p++) {
          const isMe = pad.eq(p);
          padPos[p]!.store(select(isMe, 0, padPos[p]!.load()));
          padGate[p]!.store(select(isMe, true, padGate[p]!.load()));
          padVel[p]!.store(select(isMe, velNorm, padVel[p]!.load()));
        }
      });

      forSample((i) => {
        let mix: Node<"f32"> = num(0);
        for (let p = 0; p < NUM_PADS; p++) {
          const gate = padGate[p]!.load();
          const pos = padPos[p]!.load();
          const len = padLens[p]!.load();
          const active = select(gate, pos.lt(len), false);
          const v = pads[p]!.read(pos);
          const vel = padVel[p]!.load();
          const contrib = select(active, v.mul(vel), 0);
          mix = mix.add(contrib);
          // advance position; deactivate when done
          padPos[p]!.store(select(active, pos.add(1), pos));
          padGate[p]!.store(select(active, gate, false));
        }
        const sig = mix.mul(masterVol.at(i));
        out.left.set(i, sig);
        out.right.set(i, sig);
      });
    },
  };
});
