/**
 * Browser e2e fixture — a self-generating sawtooth (no input). Used by the
 * cross-realm test: the same processor is run through the real AudioWorklet and
 * through `renderOffline`, and the two outputs must be bit-exact. Self-generating
 * (a phase accumulator) so there is no input-alignment ambiguity between realms.
 */

import { audioOutput, defineProcessor, forSample, select, state } from "../../../index.ts";

export const saw = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const phase = state.f32(0).named("phase");
  return {
    process: () => {
      forSample((i) => {
        const p = phase.read().add(0.013);
        const wrapped = select(p.gt(1), p.add(-1), p);
        phase.write(wrapped);
        out.ch(0).at(i).write(wrapped.mul(2).add(-1));
      });
    },
  };
});
