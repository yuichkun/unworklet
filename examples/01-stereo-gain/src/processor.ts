/**
 * Canonical Ex 1 full (= `docs/12-canonical-examples.md` §1)。 stereo gain +
 * per-sample peak meter (= `state.f32(0).expose({ publish: { rateFps: 30 } })`)
 * を WASM 内 で 計 算 + worklet template が SAB 経 由 で main に 30 fps で 公 開、
 * main 側 で `node.state.meterL.subscribe(...)` で UI に 接 続。
 *
 * meter 計 算: per-sample で abs(out).max(meter.load()) → state に store (= peak
 * hold)、 per-block 末 尾 で meter.store(meter.load() × 0.95) (= 減 衰 で meter
 * が 直 近 peak に 張 り 付 か な い path)。
 */

import { audioInput, audioOutput, defineProcessor, forSample, param, state } from "@unworklet/core";

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
        meterL.store(l.abs().max(meterL.load()));
        meterR.store(r.abs().max(meterR.load()));
      });
      meterL.store(meterL.load().mul(0.95));
      meterR.store(meterR.load().mul(0.95));
    },
  };
});
