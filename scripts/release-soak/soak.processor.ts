import {
  audioOutput,
  defineProcessor,
  event,
  f32,
  forSample,
  state,
} from "../../packages/core/src/index.ts";

export const soak = defineProcessor(() => {
  const output = audioOutput({ channels: 1, name: "main" });
  const quanta = state.i32(0).expose({ name: "quanta", publish: { rateFps: 4 } });
  const sequence = state.i32(0);
  const frame = state.buffer.f32({ size: 4 });
  const sysex = state.buffer.u8({ size: 9 });
  const echoBytes = state.buffer.u8({ size: 9 });
  const scalar = event<{ sequence: number; complement: number }>({
    to: "main",
    name: "scalar",
    capacity: 1024,
  });
  const typed = event<{ sequence: number; samples: Float32Array }>({
    to: "main",
    name: "typed",
    capacity: 1024,
    payloadCapacity: 16,
  });
  const midi = event.midi({ to: "main", name: "midi", capacity: 1024 });
  const midiIn = event.midi({ from: "main", name: "midiIn", capacity: 1024 });
  const midiEcho = event.midi({ to: "main", name: "midiEcho", capacity: 1024 });
  return {
    process: () => {
      quanta.write(quanta.read().add(1));
      midiIn.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
        midiEcho.emitIf(true, { type: "noteOn", channel, note, velocity, atSample });
      });
      midiIn.onEvent("sysex", ({ data, length, atSample }) => {
        echoBytes.copyFrom(data);
        midiEcho.emitIf(true, { type: "sysex", data: echoBytes, length, atSample });
      });
      forSample((i, everyNSamples) => {
        output.ch(0).at(i).write(0);
        everyNSamples(8192, () => {
          sequence.write(sequence.read().add(1));
          const counter = sequence.read();
          const value = f32(counter);
          scalar.emitIf(true, { sequence: value, complement: f32(1_000_000).sub(value) });
          frame.write(0, value);
          frame.write(1, f32(1_000_000).sub(value));
          frame.write(2, value.mul(2).add(3));
          frame.write(3, value.mul(-2).sub(3));
          typed.emitIf(true, { sequence: value, samples: frame, length: 4 });
          const low = counter.mod(128);
          const middle = counter.div(128).mod(128);
          const high = counter.div(16384).mod(128);
          midi.emitIf(true, {
            type: "noteOn",
            channel: counter.div(128).mod(16),
            note: low,
            velocity: low.mul(-1).add(127),
            atSample: i,
          });
          sysex.write(0, 0xf0);
          sysex.write(1, 0x7d);
          sysex.write(2, low);
          sysex.write(3, middle);
          sysex.write(4, high);
          sysex.write(5, low.mul(-1).add(127));
          sysex.write(6, middle.mul(-1).add(127));
          sysex.write(7, high.mul(-1).add(127));
          sysex.write(8, 0xf7);
          midi.emitIf(true, { type: "sysex", data: sysex, length: 9, atSample: i });
        });
      });
    },
  };
});
