import { audioOutput, defineProcessor, event, f32, forSample, state } from "../../../index.ts";

export const native48Midi = defineProcessor(
  () => {
    const output = audioOutput({ channels: 1, name: "main" });
    const input = event.midi({ from: "main", name: "commands", capacity: 16 });
    const reply = event.midi({ to: "main", name: "replies", capacity: 16 });
    const count = state.i32(0).named("count");
    const blocks = state.i32(0).named("blocks");
    const level = state.f32(0).named("level");
    const history = state.buffer
      .i32({ size: 20 })
      .expose({ name: "history", snapshot: "persistent" });
    const last = state.buffer.f32({ size: 128 }).expose({ name: "last", snapshot: "persistent" });
    return {
      process: () => {
        input.onEvent("noteOn", ({ channel, note, velocity, atSample }) => {
          const base = count.read().mul(5);
          history.write(base, 144);
          history.write(base.add(1), channel);
          history.write(base.add(2), note);
          history.write(base.add(3), velocity);
          history.write(base.add(4), atSample);
          count.write(count.read().add(1));
          level.write(f32(velocity).div(128));
          reply.emitIf(true, {
            type: "noteOn",
            channel,
            note: note.add(12),
            velocity: velocity,
            atSample,
          });
        });
        input.onEvent("cc", ({ channel, controller, value, atSample }) => {
          const base = count.read().mul(5);
          history.write(base, 176);
          history.write(base.add(1), channel);
          history.write(base.add(2), controller);
          history.write(base.add(3), value);
          history.write(base.add(4), atSample);
          count.write(count.read().add(1));
          level.write(f32(value).div(128));
          reply.emitIf(true, {
            type: "cc",
            channel,
            controller: controller,
            value: value.add(1),
            atSample,
          });
        });
        input.onEvent("noteOff", ({ channel, note, velocity, atSample }) => {
          const base = count.read().mul(5);
          history.write(base, 128);
          history.write(base.add(1), channel);
          history.write(base.add(2), note);
          history.write(base.add(3), velocity);
          history.write(base.add(4), atSample);
          count.write(count.read().add(1));
          level.write(0);
          reply.emitIf(true, {
            type: "noteOff",
            channel,
            note: note.add(12),
            velocity: velocity,
            atSample,
          });
        });
        blocks.write(blocks.read().add(1));
        forSample((i) => {
          const sample = level.read().add(f32(i).div(1024));
          output.ch(0).at(i).write(sample);
          last.write(i, sample);
        });
      },
    };
  },
  { id: "native48-midi" },
);
