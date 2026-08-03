/**
 * Browser e2e fixture: a processor that reflects state via message<T>.
 * `setCount({ value })` sends a value from main → worklet, stores it in state.counter,
 * and publishes it (rateFps 30) so the main thread can observe the update.
 */

import { event, audioOutput, defineProcessor, forSample, state } from "../../../index.ts";

export const messageCounter = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  // A `number` message field rides the f32 wire, so the reflecting slot is f32 —
  // `counter.write(value)` needs no cast and a fractional value would survive too.
  const counter = state
    .f32(0)
    .expose({ name: "counter", snapshot: "transient", publish: { rateFps: 30 } });
  const setCount = event<{ value: number }>({ from: "main", name: "setCount" });
  return {
    process: () => {
      setCount.onReceive(({ value }) => {
        counter.write(value);
      });
      forSample((i) => {
        out.ch(0).at(i).write(0);
      });
    },
  };
});
