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
  select,
  eq,
  gt,
  lt,
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

  const uploadPad = message<{ pad: number; samples: Float32Array }>({ name: "uploadPad" });
  const triggerPad = message<{ pad: number; velocity: number }>({ name: "triggerPad" });

  const padTriggered = event<{ pad: number; velocity: number }>({ name: "padTriggered" });

  const midi = midiInput({ name: "midi" });

  return {
    process: () => {
      uploadPad.onReceive(({ pad, samples }) => {
        // Build-time mode guard. In WASM capture mode, `samples` is an AST
        // proxy and `pad` is an AST node; we cannot drive a runtime-indexed
        // typed-array copy without the variable-length payload wire format
        // (docs/02-messaging.md §5.2 — pending). In interpret mode, both
        // are concrete values and the copy proceeds normally.
        if (typeof samples?.length !== "number" || typeof pad !== "number") return;
        const len = Math.min(samples.length, MAX_SAMPLE_LEN);
        for (let i = 0; i < len; i++) pads[pad]!.write(i, samples[i]!);
        for (let i = len; i < MAX_SAMPLE_LEN; i++) pads[pad]!.write(i, 0);
        padLens[pad]!.store(len);
      });

      triggerPad.onReceive(({ pad, velocity }) => {
        // Build-time fan-out: for each pad slot, set state if pad matches.
        for (let p = 0; p < NUM_PADS; p++) {
          const isMe = eq(pad, p);
          padPos[p]!.store(select(isMe, 0, padPos[p]!.load()));
          padGate[p]!.store(select(isMe, true, padGate[p]!.load()));
          padVel[p]!.store(select(isMe, velocity, padVel[p]!.load()));
        }
      });

      midi.onEvent("noteOn", ({ note, velocity, atSample }) => {
        const pad = sub(note, 36);
        for (let p = 0; p < NUM_PADS; p++) {
          const isMe = eq(pad, p);
          padPos[p]!.store(select(isMe, 0, padPos[p]!.load()));
          padGate[p]!.store(select(isMe, true, padGate[p]!.load()));
          padVel[p]!.store(select(isMe, mul(velocity, 1 / 127), padVel[p]!.load()));
        }
      });

      forSample((i) => {
        let mix: Node<"f32"> = mul(0, 0) as any;
        for (let p = 0; p < NUM_PADS; p++) {
          const gate = padGate[p]!.load();
          const pos = padPos[p]!.load();
          const len = padLens[p]!.load();
          const active = select(gate, lt(pos, len), false);
          const v = pads[p]!.read(pos);
          const vel = padVel[p]!.load();
          const contrib = select(active, mul(v, vel), 0);
          mix = add(mix, contrib);
          // advance position; deactivate when done
          padPos[p]!.store(select(active, add(pos, 1), pos));
          padGate[p]!.store(select(active, gate, false));
        }
        const sig = mul(mix, masterVol.at(i));
        out.set(0, i, sig);
        out.set(1, i, sig);
      });
    },
  };
});
