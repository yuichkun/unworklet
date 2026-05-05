import { expect, test } from "vite-plus/test";
import {
  defineProcessor,
  audioInput,
  audioOutput,
  param,
  state,
  forSample,
  mul,
  max,
  abs,
} from "@unworklet/core";
import { Engine } from "@unworklet/core/internal";

test("stereo gain processor renders audio", () => {
  const stereoGain = defineProcessor(() => {
    const main = audioInput({ channels: 2, name: "main" });
    const out = audioOutput({ channels: 2, name: "main" });
    const gain = param({
      default: 0.5,
      min: 0.0,
      max: 4.0,
      automationRate: "a-rate",
      name: "gain",
    });

    return {
      process: () => {
        forSample((i) => {
          const l = mul(main.at(0, i), gain.at(i));
          const r = mul(main.at(1, i), gain.at(i));
          out.set(0, i, l);
          out.set(1, i, r);
        });
      },
    };
  });

  const engine = new Engine(stereoGain, { sampleRate: 48000, blockSize: 128 });

  // Build input: ramp 0..127 in channel 0, all 1.0 in channel 1
  const inL = new Float32Array(128);
  const inR = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    inL[i] = i / 128;
    inR[i] = 1.0;
  }

  const result = engine.render({ main: [inL, inR] });
  const outL = result.outputs.main![0]!;
  const outR = result.outputs.main![1]!;

  // gain default is 0.5, so out = in * 0.5
  expect(outL[0]).toBeCloseTo(0);
  expect(outL[64]).toBeCloseTo((64 / 128) * 0.5);
  expect(outR[10]).toBeCloseTo(0.5);
});

test("state.publish meter accumulates peak", () => {
  const meter = defineProcessor(() => {
    const main = audioInput({ channels: 1, name: "main" });
    const out = audioOutput({ channels: 1, name: "main" });
    const peak = state.f32(0, { name: "peak", publish: { rateFps: 60 } });
    return {
      process: () => {
        forSample((i) => {
          const v = main.at(0, i);
          out.set(0, i, v);
          peak.store(max(peak.load(), abs(v)));
        });
      },
    };
  });

  const engine = new Engine(meter, { sampleRate: 48000, blockSize: 128 });

  const data = new Float32Array(128);
  for (let i = 0; i < 128; i++) data[i] = Math.sin((i / 128) * Math.PI * 2) * 0.7;
  engine.render({ main: [data] });

  const peakSlot = engine.rt.allScopes[0]!.states[0]!;
  expect(peakSlot.read()).toBeGreaterThan(0.6);
  expect(peakSlot.read()).toBeLessThanOrEqual(0.7);
});
