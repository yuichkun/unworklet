/**
 * Browser e2e fixture — canonical example 1 in full (stereo gain + L/R meter).
 * Loaded via `?worklet` import onto an AudioWorkletNode and executed inside a
 * real `AudioContext`.
 */

import {
  audioInput,
  audioOutput,
  defineProcessor,
  forSample,
  param,
  state,
} from "../../../index.ts";

export const stereoGain = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: "main" });
  const out = audioOutput({ channels: 2, name: "main" });
  const gain = param
    .f32({ default: 1.0, min: 0.0, max: 4.0, automationRate: "a-rate" })
    .named("gain");

  const meterL = state
    .f32(0)
    .expose({ name: "meterL", snapshot: "transient", publish: { rateFps: 30 } });
  const meterR = state
    .f32(0)
    .expose({ name: "meterR", snapshot: "transient", publish: { rateFps: 30 } });

  return {
    process: () => {
      forSample((i) => {
        const l = input.left.at(i).mul(gain.at(i));
        const r = input.right.at(i).mul(gain.at(i));
        out.left.at(i).write(l);
        out.right.at(i).write(r);
        meterL.write(l.abs().max(meterL.read()));
        meterR.write(r.abs().max(meterR.read()));
      });
      meterL.write(meterL.read().mul(0.95));
      meterR.write(meterR.read().mul(0.95));
    },
  };
});
