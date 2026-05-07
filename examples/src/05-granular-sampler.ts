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
  div,
  mod,
  sin,
  select,
  lte,
  gt,
  eq,
  exp,
  type Node,
} from "@unworklet/core";

const SAMPLE_BUFFER_LEN = 48000 * 4;
const NUM_VOICES = 16;
const WAVEFORM_FRAME = 1024;

export const granularSampler = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 2, name: "main" });

  const grainSize = param({
    default: 100,
    min: 10,
    max: 500,
    automationRate: "k-rate",
    name: "grainSizeMs",
  });
  const grainDensity = param({
    default: 30,
    min: 1,
    max: 100,
    automationRate: "k-rate",
    name: "grainHz",
  });
  const playbackPos = param({
    default: 0.5,
    min: 0,
    max: 1,
    automationRate: "a-rate",
    name: "playbackPos",
  });
  const pitch = param({
    default: 1.0,
    min: 0.25,
    max: 4.0,
    automationRate: "a-rate",
    name: "pitch",
  });

  const sampleBuf = buffer.f32({
    size: SAMPLE_BUFFER_LEN,
    name: "sampleBuf",
    snapshot: "persistent",
  });
  const sampleLen = state.i32(0, { name: "sampleLen" });

  const waveformView = buffer.f32({
    size: WAVEFORM_FRAME,
    name: "waveformView",
    publish: { rateFps: 15 },
  });

  const voicePos: ReturnType<typeof state.f32>[] = [];
  const voiceRemaining: ReturnType<typeof state.i32>[] = [];
  const voiceGate: ReturnType<typeof state.bool>[] = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    voicePos.push(state.f32(0, { name: `voicePos_${v}` }));
    voiceRemaining.push(state.i32(0, { name: `voiceRemaining_${v}` }));
    voiceGate.push(state.bool(false, { name: `voiceGate_${v}` }));
  }
  const voiceRR = state.i32(0, { name: "voiceRR" });
  const nextSpawnIn = state.i32(0, { name: "nextSpawnIn" });

  const activeNote = state.i32(60, { name: "activeNote" });
  const activeVel = state.f32(0, { name: "activeVel" });
  const playingCount = state.i32(0, { name: "playingCount", publish: { rateFps: 10 } });

  const uploadSample = message<{ samples: Float32Array; len: number }>({
    name: "uploadSample",
    capacity: 4,
    payload: { samples: { type: "f32", maxLength: SAMPLE_BUFFER_LEN } },
  });
  const grainSpawned = event<{ voice: number; pos: number }>({ name: "grainSpawned" });

  const midi = midiInput({ name: "midi" });

  return {
    process: () => {
      uploadSample.onReceive(({ samples }) => {
        // Copy the typed-array payload from the message slot into the persistent
        // sampleBuf via a single memory.copy, then store the length for the
        // render loop to read.
        samples.copyTo(sampleBuf, 0, samples.length());
        sampleLen.store(samples.length());
      });

      midi.onEvent("noteOn", ({ note, velocity }) => {
        activeNote.store(note);
        activeVel.store(mul(velocity, 1 / 127));
      });
      midi.onEvent("noteOff", () => {
        activeVel.store(0);
      });

      const samplesPerSpawn = div(ctx.sampleRate, grainDensity.at(0));
      const grainSamples = mul(grainSize.at(0), ctx.sampleRate / 1000);

      forSample((i) => {
        const cd = sub(nextSpawnIn.load(), 1);
        const spawn = lte(cd, 0);
        nextSpawnIn.store(select(spawn, samplesPerSpawn, cd));

        // On spawn: assign the round-robin slot. We use `select` rather than a
        // JS `if`, since the spawn / isMe values are graph nodes — JS branches
        // would never see them and silently emit dead code.
        const rrSlot = voiceRR.load();
        const startPos = mul(playbackPos.at(i), sampleLen.load());
        for (let v = 0; v < NUM_VOICES; v++) {
          const isMe = select(spawn, eq(rrSlot, v), false);
          voicePos[v]!.store(select(isMe, startPos, voicePos[v]!.load()));
          voiceRemaining[v]!.store(select(isMe, grainSamples, voiceRemaining[v]!.load()));
          voiceGate[v]!.store(select(isMe, true, voiceGate[v]!.load()));
          grainSpawned.emitIf(isMe, {
            atSample: i,
            voice: v,
            pos: voicePos[v]!.load() as unknown as number,
          } as any);
        }
        voiceRR.store(select(spawn, mod(add(rrSlot, 1), NUM_VOICES), rrSlot));

        let lSum: Node<"f32"> = mul(0, 0);
        let rSum: Node<"f32"> = mul(0, 0);
        for (let v = 0; v < NUM_VOICES; v++) {
          const gate = voiceGate[v]!.load();
          const pos = voicePos[v]!.load();
          const rem = voiceRemaining[v]!.load();

          const phase = sub(1, div(rem, grainSamples));
          const winLin = sin(mul(phase, Math.PI));
          const win = mul(winLin, winLin);

          const sample = sampleBuf.readInterpolated(pos);
          const sig = mul(sample, mul(win, activeVel.load()));

          const contrib = select(gate, sig, mul(0, 0));
          lSum = add(lSum, contrib);
          rSum = add(rSum, contrib);

          voicePos[v]!.store(
            select(
              gate,
              add(pos, mul(pitch.at(i), exp(mul(sub(activeNote.load(), 60), Math.LN2 / 12)))),
              pos,
            ),
          );
          voiceRemaining[v]!.store(select(gate, sub(rem, 1), rem));
          voiceGate[v]!.store(select(gate, gt(rem, 0), gate));
        }

        out.left.set(i, lSum);
        out.right.set(i, rSum);
      });

      let count: Node<"i32"> = 0 as unknown as Node<"i32">;
      for (let v = 0; v < NUM_VOICES; v++) {
        count = add(count, select(voiceGate[v]!.load(), 1, 0));
      }
      playingCount.store(count);
    },
  };
});
