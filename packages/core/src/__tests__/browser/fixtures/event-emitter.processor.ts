/**
 * Browser e2e fixture: a processor that drives event<T> emission. Inside
 * forSample, the gate state is held true and emitIf is driven by a stateLoad
 * condition (the Q32-c constant-truthy avoidance path), causing one event to
 * fire per real audio quantum.
 */

import {
  audioInput,
  audioOutput,
  defineProcessor,
  event,
  forSample,
  state,
} from "../../../index.ts";

export const eventEmitter = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: "main" });
  const out = audioOutput({ channels: 1, name: "main" });
  const gate = state.named("gate").bool(true);
  const peak = event<{ level: number }>({ to: "main", name: "peak", capacity: 16 });
  return {
    process: () => {
      gate.write(true);
      forSample((i) => {
        peak.emitIf(gate.read(), { atSample: i, level: input.ch(0).at(i) });
        out.ch(0).at(i).write(input.ch(0).at(i));
      });
    },
  };
});
