import {
  defineProcessor,
  audioOutput,
  state,
  forSample,
  midiInput,
  midiOutput,
  message,
  event,
  add,
  mod,
  eq,
  gt,
  select,
  mul,
  type Node,
} from "@unworklet/core";

const PATTERN_LEN = 16;

export const arpeggiator = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });

  const midiIn = midiInput({ name: "midiIn" });
  const midiOut = midiOutput({ name: "midiOut" });

  const pattern: ReturnType<typeof state.i32>[] = [];
  for (let s = 0; s < PATTERN_LEN; s++) {
    pattern.push(state.i32(0, { name: `step_${s}` }));
  }

  const loadPattern = message<{ steps: Int32Array }>({ name: "loadPattern" });

  const rootNote = state.i32(60, { name: "rootNote" });
  const lastVel = state.i32(96, { name: "lastVel" });
  const stepIdx = state.i32(0, { name: "stepIdx", publish: { rateFps: 60 } });
  // 1/8 second per step, sample-rate-correct via ctx.samples (ms → samples).
  const samplesPerStep = state.i32(ctx.samples(125), { name: "samplesPerStep" });
  const sampleAccum = state.i32(0, { name: "sampleAccum" });

  const stepFired = event<{ step: number; note: number }>({ name: "stepFired" });

  return {
    process: () => {
      loadPattern.onReceive(({ steps }) => {
        const len = Math.min(steps.length, PATTERN_LEN);
        for (let s = 0; s < len; s++) {
          pattern[s]!.store(steps[s]!);
        }
      });

      midiIn.onEvent("noteOn", ({ note, velocity }) => {
        rootNote.store(note);
        lastVel.store(velocity);
      });

      forSample((i) => {
        out.set(0, i, mul(0, 0));

        const acc = add(sampleAccum.load(), 1);
        const roll = gt(acc, samplesPerStep.load());
        sampleAccum.store(select(roll, 0, acc));

        const nextStep = mod(add(stepIdx.load(), 1), PATTERN_LEN);

        let offset: Node<"i32"> = pattern[0]!.load();
        for (let s = 1; s < PATTERN_LEN; s++) {
          offset = select(eq(nextStep, s), pattern[s]!.load(), offset);
        }
        const fireNote = add(rootNote.load(), offset);

        midiOut.emitIf(roll, {
          type: "noteOn",
          atSample: i as unknown as number,
          note: fireNote as unknown as number,
          velocity: lastVel.load() as unknown as number,
          channel: 0,
        });

        stepFired.emitIf(roll, {
          atSample: i,
          step: nextStep as unknown as number,
          note: fireNote as unknown as number,
        });

        stepIdx.store(select(roll, nextStep, stepIdx.load()));
      });
    },
  };
});
