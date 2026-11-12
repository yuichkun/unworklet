/**
 * Browser e2e fixture — a 440 Hz sine whose phase increment is derived from
 * `ctx.sampleRate` at compile time. A context at another rate only plays 440 Hz
 * when the processor is compiled for that rate.
 */

import { audioOutput, defineProcessor, forSample, sin, state } from "../../../index.ts";

export const sine440 = defineProcessor((ctx) => {
  const out = audioOutput({ channels: 1, name: "main" });
  const phase = state.f32(0);
  return {
    process: () => {
      forSample((i) => {
        phase.write(
          phase
            .read()
            .add(440 / ctx.sampleRate)
            .mod(1),
        );
        out
          .ch(0)
          .at(i)
          .write(sin(phase.read().mul(2 * Math.PI)).mul(0.5));
      });
    },
  };
});
