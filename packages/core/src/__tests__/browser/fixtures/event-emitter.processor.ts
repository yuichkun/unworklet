/**
 * Browser e2e fixture = event<T> emit を 走 ら せ る processor。 forSample 内 で
 * gate state を true 固 定 + stateLoad cond で emitIf (= Q32-c constant-truthy
 * 回 避 path) = real audio quantum ご と に event 出 る。
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
