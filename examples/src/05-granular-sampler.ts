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
  sin,
  select,
  lte,
  gt,
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

  const uploadSample = message<{ samples: Float32Array }>({ name: "uploadSample" });
  const grainSpawned = event<{ voice: number; pos: number }>({ name: "grainSpawned" });

  const midi = midiInput({ name: "midi" });

  return {
    process: () => {
      uploadSample.onReceive(({ samples }) => {
        const len = Math.min(samples.length, SAMPLE_BUFFER_LEN);
        for (let i = 0; i < len; i++) {
          sampleBuf.write(i, samples[i]!);
        }
        sampleLen.store(len);
        const stride = Math.max(1, Math.floor(len / WAVEFORM_FRAME));
        for (let i = 0; i < WAVEFORM_FRAME; i++) {
          const src = i * stride;
          waveformView.write(i, src < len ? samples[src]! : 0);
        }
      });

      midi.onEvent("noteOn", ({ note, velocity }) => {
        activeNote.store(note);
        activeVel.store(velocity / 127);
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

        // On spawn: pick voice (round-robin)
        const rrSlot = voiceRR.load();
        for (let v = 0; v < NUM_VOICES; v++) {
          const isMe = spawn && rrSlot === v;
          if (isMe) {
            const startPos = (playbackPos.at(i) as unknown as number) * sampleLen.load();
            voicePos[v]!.store(startPos);
            voiceRemaining[v]!.store(grainSamples as unknown as number);
            voiceGate[v]!.store(true);
            grainSpawned.emitIf(true, {
              atSample: i,
              voice: v,
              pos: voicePos[v]!.load() as unknown as number,
            } as any);
          }
        }
        if (spawn) {
          voiceRR.store((rrSlot + 1) % NUM_VOICES);
        }

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

        out.set(0, i, lSum);
        out.set(1, i, rSum);
      });

      let count: Node<"i32"> = 0 as unknown as Node<"i32">;
      for (let v = 0; v < NUM_VOICES; v++) {
        count = add(count, select(voiceGate[v]!.load(), 1, 0));
      }
      playingCount.store(count);
    },
  };
});
