/**
 * Browser e2e fixture = message<T> 経 由 で state を 反 映 す る processor。
 * `setCount({ value })` main → worklet で state.counter に store + state.publish
 * (= rateFps 30) で main 側 で 反 映 観 測。
 */

import { audioOutput, defineProcessor, forSample, message, state } from "../../../index.ts";

export const messageCounter = defineProcessor(() => {
  const out = audioOutput({ channels: 1, name: "main" });
  const counter = state
    .i32(0)
    .expose({ name: "counter", snapshot: "transient", publish: { rateFps: 30 } });
  const setCount = message<{ value: number }>({ name: "setCount" });
  return {
    process: () => {
      setCount.onReceive(({ value }) => {
        counter.store(value);
      });
      forSample((i) => {
        out.ch(0).at(i).write(0);
      });
    },
  };
});
