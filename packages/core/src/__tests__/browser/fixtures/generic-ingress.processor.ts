import { audioOutput, defineProcessor, event, f32, forSample, state } from "../../../index.ts";

export const genericIngress = defineProcessor(
  () => {
    const output = audioOutput({ channels: 1, name: "main" });
    const incoming = event<{ id: number; gain: number; flag: boolean; samples: Float32Array }>({
      from: "main",
      name: "incoming",
      capacity: 16,
      payloadCapacity: 16,
    });
    const record = event<{
      quantum: number;
      id: number;
      gain: number;
      flag: number;
      size: number;
      a: number;
      b: number;
      c: number;
      level: number;
    }>({ to: "main", name: "record", capacity: 32 });
    const frame = event<{ quantum: number; count: number; level: number }>({
      to: "main",
      name: "frame",
      capacity: 16,
    });
    const blocks = state.i32(0).named("blocks");
    const count = state.i32(0).named("count");
    const level = state.f32(0).named("level");
    const phase = state.f32(0).named("phase");
    const history = state.buffer
      .f32({ size: 512 })
      .expose({ name: "history", snapshot: "persistent" });
    return {
      process() {
        incoming.onReceive(({ id, gain, flag, samples }) => {
          level.write(
            level
              .read()
              .add(gain.mul(samples.at(0)))
              .add(f32(flag).mul(0.125))
              .add(id.mul(0.001)),
          );
          const offset = count.read().mul(9);
          history.write(offset, f32(blocks.read()));
          history.write(offset.add(1), id);
          history.write(offset.add(2), gain);
          history.write(offset.add(3), f32(flag));
          history.write(offset.add(4), f32(samples.length));
          for (let k = 0; k < 3; k++) history.write(offset.add(k + 5), samples.at(k));
          history.write(offset.add(8), level.read());
          record.emitIf(true, {
            atSample: 0,
            quantum: f32(blocks.read()),
            id,
            gain,
            flag: f32(flag),
            size: f32(samples.length),
            a: samples.at(0),
            b: samples.at(1),
            c: samples.at(2),
            level: level.read(),
          });
          count.write(count.read().add(1));
        });
        forSample((i) => {
          phase.write(phase.read().add(0.003));
          output
            .ch(0)
            .at(i)
            .write(phase.read().add(level.read().mul(0.01)));
        });
        frame.emitIf(true, {
          atSample: 127,
          quantum: f32(blocks.read()),
          count: f32(count.read()),
          level: level.read(),
        });
        blocks.write(blocks.read().add(1));
      },
    };
  },
  { id: "generic-ingress" },
);
